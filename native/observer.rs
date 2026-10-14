//! Local, optional observation after decoding. Never serializes a request or changes transport.
//! All tokenization and disk I/O happen on one bounded worker, outside the stream task.
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, mpsc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::future::Future;

const MAX_DELTA: usize = 16_384;
const MAX_TEXT: usize = 262_144;
const MAX_REQUESTS: usize = 128;
static NEXT: AtomicU64 = AtomicU64::new(1);
static WORKER: OnceLock<Option<mpsc::SyncSender<Packet>>> = OnceLock::new();

/// Observation-only context; never serialized into a model request.
pub struct Generation {
    thread: String, turn: String, id: String, start: Instant, epoch: f64, compaction: bool,
}
tokio::task_local! { static GENERATION: Arc<Generation>; }
pub(crate) fn current_generation() -> Option<Arc<Generation>> {
    GENERATION.try_with(Arc::clone).ok()
}
pub async fn scope_generation<F: Future>(thread: &str, turn: &str, start: Instant, compaction: bool, future: F) -> F::Output {
    if std::env::var_os("CODEX_SPEED_HUD_NATIVE_DIR").is_none() { return future.await; }
    let epoch = SystemTime::now().duration_since(UNIX_EPOCH).map(|v| v.as_secs_f64() * 1000.0).unwrap_or(0.0)
        - start.elapsed().as_secs_f64() * 1000.0;
    let generation = Arc::new(Generation { thread: thread.into(), turn: turn.into(),
        id: format!("generation-{}-{}-{}", std::process::id(), epoch as u64, NEXT.fetch_add(1, Ordering::Relaxed)),
        start, epoch, compaction });
    GENERATION.scope(generation, future).await
}

fn safe(value: &str) -> Option<String> {
    (!value.is_empty() && value.len() <= 160 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)))
        .then(|| value.to_string())
}

struct Packet {
    id: String,
    elapsed: f64,
    lost: Arc<AtomicBool>,
    data: Data,
}
enum Data {
    Begin { thread: String, turn: String, model: String, epoch: f64, generation: Option<Arc<Generation>>, offset: Option<f64> },
    Event { response_id: Option<String>, compaction: bool, flow: bool, tool: Option<(String, String)>, output: Option<u64>, terminal: Option<&'static str>, invalid: bool },
    End,
}

pub(crate) struct Observer {
    id: String,
    start: Instant,
    lost: Arc<AtomicBool>,
    sender: mpsc::SyncSender<Packet>,
}

impl Observer {
    pub(crate) fn begin(thread: Option<&str>, turn: Option<&str>, model: &str, warmup: bool, generation: Option<Arc<Generation>>) -> Option<Self> {
        if warmup || std::env::var_os("CODEX_SPEED_HUD_NATIVE_DIR").is_none() { return None; }
        let thread = safe(thread?)?;
        let turn = safe(turn?)?;
        let model = safe(model)?;
        let start = Instant::now();
        let epoch = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0;
        let sender = WORKER.get_or_init(|| {
            let directory = PathBuf::from(std::env::var_os("CODEX_SPEED_HUD_NATIVE_DIR")?);
            if !directory.is_absolute() { return None; }
            let (tx, rx) = mpsc::sync_channel(256);
            std::thread::Builder::new().name("codex-speed-observer".into())
                .spawn(move || worker(directory, rx)).ok()?;
            Some(tx)
        }).as_ref()?.clone();
        let result = Self { id: format!("{}-{}-{}", std::process::id(), epoch as u64, NEXT.fetch_add(1, Ordering::Relaxed)), start,
            lost: Arc::new(AtomicBool::new(false)), sender };
        let generation = generation.filter(|g| g.thread == thread && g.turn == turn && g.start <= start);
        let offset = generation.as_ref().map(|g| start.duration_since(g.start).as_secs_f64() * 1000.0);
        result.send(Data::Begin { thread, turn, model, epoch, generation, offset });
        Some(result)
    }
    fn send(&self, data: Data) {
        if self.sender.try_send(Packet { id: self.id.clone(), elapsed: self.start.elapsed().as_secs_f64() * 1000.0,
            lost: self.lost.clone(), data }).is_err() { self.lost.store(true, Ordering::Relaxed); }
    }
    pub(crate) fn event(&self, kind: &str, response: Option<&Value>, item: Option<&Value>, item_id: Option<&str>, call_id: Option<&str>, delta: Option<&str>) {
        let response_id = response.and_then(|r| r.get("id")).and_then(Value::as_str).and_then(safe);
        let compaction = kind.starts_with("response.compaction.") || item.and_then(|i| i.get("type")).and_then(Value::as_str) == Some("compaction")
            || response.and_then(|r| r.get("output")).and_then(Value::as_array).is_some_and(|a| a.iter().any(|v| v.get("type").and_then(Value::as_str) == Some("compaction")));
        let is_tool = matches!(kind, "response.function_call_arguments.delta" | "response.custom_tool_call_input.delta" | "response.mcp_call_arguments.delta");
        let key = item_id.or(call_id).and_then(safe);
        let invalid = is_tool && (key.is_none() || delta.is_none_or(|s| s.len() > MAX_DELTA));
        let tool = if is_tool && !invalid { key.zip(delta.map(str::to_string)) } else { None };
        let terminal = match kind { "response.completed" => Some("completed"), "response.failed" | "response.incomplete" => Some("failed"), _ => None };
        let output = response.and_then(|r| r.get("usage")).and_then(|u| u.get("output_tokens")).and_then(Value::as_u64);
        // Capture even response.created: the metric is first stream event, not first visible text.
        self.send(Data::Event { response_id, compaction, flow: kind.starts_with("response."), tool, output, terminal, invalid });
    }
}
impl Drop for Observer { fn drop(&mut self) { self.send(Data::End); } }

#[derive(Default)]
struct Tool { text: String, tokens: usize }
struct Sample {
    thread: String, turn: String, model: String, epoch: f64, generation: Option<Arc<Generation>>, offset: Option<f64>, response: Option<String>,
    first: Option<f64>, elapsed: f64, completed: Option<f64>, compaction: bool, status: &'static str,
    tools: HashMap<String, Tool>, first_tool: Option<f64>, last_tool: Option<f64>,
    points: VecDeque<(f64, usize)>, tps: Option<f64>, tokens: usize, output: Option<u64>, invalid: bool,
    lost: Arc<AtomicBool>, updated: Instant, published_first: bool, last_published: Instant,
}
impl Sample {
    fn accept(&mut self, elapsed: f64, data: Data, encoder: &tiktoken_rs::CoreBPE) {
        self.updated = Instant::now();
        if self.completed.is_some() { return; }
        self.elapsed = elapsed;
        match data {
            Data::Event { response_id, compaction, flow, tool, output, terminal, invalid } => {
                self.response = response_id.or(self.response.take()); self.compaction |= compaction; self.invalid |= invalid;
                if flow && self.first.is_none() { self.first = Some(elapsed); }
                if let Some((id, delta)) = tool {
                    if self.tools.len() >= 64 && !self.tools.contains_key(&id) { self.invalid = true; }
                    if !self.invalid {
                        let text_bytes: usize = self.tools.values().map(|t| t.text.len()).sum();
                        let t = self.tools.entry(id).or_default();
                        if text_bytes + delta.len() > MAX_TEXT { self.invalid = true; }
                        else {
                            let previous = t.tokens;
                            t.text.push_str(&delta); t.tokens = encoder.encode_ordinary(&t.text).len();
                            self.tokens = self.tokens - previous + t.tokens;
                            self.first_tool.get_or_insert(elapsed); self.last_tool = Some(elapsed);
                            self.points.push_back((elapsed, self.tokens));
                            while self.points.len() > 2 && self.points[1].0 < elapsed - 2000.0 { self.points.pop_front(); }
                            if let Some((at, tokens)) = self.points.front() && elapsed - at >= 250.0 {
                                self.tps = Some(self.tokens.saturating_sub(*tokens) as f64 * 1000.0 / (elapsed - at));
                            }
                            self.status = "streaming";
                        }
                    }
                }
                self.output = output.or(self.output);
                if let Some(status) = terminal { self.status = status; self.completed = Some(elapsed); self.tools.clear(); self.points.clear(); }
                if self.invalid { self.tools.clear(); self.points.clear(); self.tps = None; }
            }
            Data::End if self.completed.is_none() => { self.status = "interrupted"; self.completed = Some(elapsed); self.tools.clear(); self.points.clear(); }
            _ => {}
        }
    }
    fn snapshot(&self, id: &str) -> Value {
        let limited = self.invalid || self.lost.load(Ordering::Relaxed);
        let stream_ms = self.last_tool.zip(self.first_tool).map(|(last, first)| last - first).unwrap_or(0.0);
        json!({ "schema": 1, "source": "native-observer", "id": id, "threadId": self.thread, "turnId": self.turn,
            "model": self.model, "responseId": self.response, "kind": if self.compaction { "compaction" } else { "response" },
            "startedAt": self.epoch, "completedAt": self.completed.map(|at| self.epoch + at), "status": self.status,
            "firstFlowBasis": if self.generation.is_some() { "generation-trigger" } else { "unknown" },
            "generationId": self.generation.as_ref().map(|g| &g.id),
            "generationStartedAt": self.generation.as_ref().map(|g| g.epoch),
            "firstEventAt": self.first.map(|ms| self.epoch + ms),
            "requestFirstStreamMs": if limited { None } else { self.first },
            "firstStreamMs": if limited { None } else { self.first.zip(self.offset).map(|(first, offset)| first + offset) }, "durationMs": self.elapsed, "toolLastAt": self.last_tool.map(|at| self.epoch + at),
            "toolHeld": self.completed.is_some(), "toolTPS": if limited { None } else { self.tps },
            "toolTokens": self.tokens, "toolStreamMs": stream_ms,
            "toolAverageTPS": if !limited && stream_ms >= 250.0 { Some(self.tokens as f64 * 1000.0 / stream_ms) } else { None },
            "outputTokens": self.output, "totalAverageTPS": if !limited && self.status == "completed" && self.elapsed > 0.0 { self.output.map(|n| n as f64 * 1000.0 / self.elapsed) } else { None }, "limited": limited })
    }
}

fn worker(directory: PathBuf, receiver: mpsc::Receiver<Packet>) {
    if fs::create_dir_all(&directory).is_err() { return; }
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        if fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).is_err() { return; }
    }
    let Ok(encoder) = tiktoken_rs::o200k_base() else { return; };
    let mut samples: HashMap<String, Sample> = HashMap::new();
    loop {
        let packet = match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(p) => p,
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                samples.retain(|id, s| {
                    if s.updated.elapsed() < Duration::from_secs(600) { return true; }
                    let _ = fs::remove_file(directory.join(format!("{id}.json"))); false
                }); continue;
            }
        };
        if let Data::Begin { thread, turn, model, epoch, generation, offset } = packet.data {
            if samples.len() >= MAX_REQUESTS {
                if let Some(id) = samples.iter().min_by_key(|(_, s)| s.updated).map(|(id, _)| id.clone()) {
                    samples.remove(&id); let _ = fs::remove_file(directory.join(format!("{id}.json")));
                }
            }
            samples.insert(packet.id.clone(), Sample { compaction: generation.as_ref().is_some_and(|g| g.compaction), thread, turn, model, epoch, generation, offset, response: None, first: None, elapsed: 0.0, completed: None,
                status: "waiting", tools: HashMap::new(), first_tool: None, last_tool: None, points: VecDeque::new(),
                tps: None, tokens: 0, output: None, invalid: false, lost: packet.lost, updated: Instant::now(),
                published_first: false, last_published: Instant::now() - Duration::from_secs(1) });
        } else if let Some(sample) = samples.get_mut(&packet.id) { sample.accept(packet.elapsed, packet.data, &encoder); }
        let Some(sample) = samples.get_mut(&packet.id) else { continue; };
        if sample.completed.is_none() && (sample.first.is_none() || sample.published_first)
            && sample.last_published.elapsed() < Duration::from_millis(100) { continue; }
        let filename = directory.join(format!("{}.json", packet.id));
        let temporary = filename.with_extension("tmp");
        let mut options = OpenOptions::new(); options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        // create_new avoids following a symlink, rename publishes one complete numeric snapshot.
        if let Ok(mut file) = options.open(&temporary) {
            if serde_json::to_writer(&mut file, &sample.snapshot(&packet.id)).is_ok() && file.flush().is_ok() {
                if fs::rename(&temporary, &filename).is_ok() {
                    sample.last_published = Instant::now(); sample.published_first = sample.first.is_some();
                }
            }
            let _ = fs::remove_file(&temporary);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Sample { Sample { thread: "thread".into(), turn: "turn".into(), model: "gpt-test".into(), epoch: 1000.0, generation: Some(Arc::new(Generation { thread: "thread".into(), turn: "turn".into(), id: "g".into(), start: Instant::now(), epoch: 1000.0, compaction: false })), offset: Some(0.0), response: None,
        first: None, elapsed: 0.0, completed: None, compaction: false, status: "waiting", tools: HashMap::new(), first_tool: None,
        last_tool: None, points: VecDeque::new(), tps: None, tokens: 0, output: None, invalid: false,
        lost: Arc::new(AtomicBool::new(false)), updated: Instant::now(), published_first: false, last_published: Instant::now() } }
    fn event(tool: Option<(&str, &str)>, terminal: Option<&'static str>) -> Data { Data::Event { response_id: Some("r".into()), compaction: false,
        flow: true, tool: tool.map(|(k, v)| (k.into(), v.into())), output: terminal.map(|_| 50), terminal, invalid: false } }
    #[test] fn parallel_tools_use_common_timeline_and_never_persist_arguments() {
        let encoder = tiktoken_rs::o200k_base().unwrap(); let mut s = sample();
        s.accept(100.0, event(None, None), &encoder);
        s.accept(200.0, event(Some(("a", "{\"secret\":")), None), &encoder);
        s.accept(300.0, event(Some(("b", "private-auth")), None), &encoder);
        s.accept(700.0, event(Some(("a", "\"value\"}")), None), &encoder);
        s.accept(800.0, event(Some(("b", " second delta")), None), &encoder);
        let expected = encoder.encode_ordinary("{\"secret\":\"value\"}").len() + encoder.encode_ordinary("private-auth second delta").len();
        let snap = s.snapshot("id"); assert_eq!(snap["toolTokens"], expected); assert_eq!(snap["toolStreamMs"], 600.0);
        assert_eq!(snap["firstStreamMs"], 100.0); assert!(!snap.to_string().contains("private-auth"));
        s.accept(1000.0, event(None, Some("completed")), &encoder);
        assert!(s.tools.is_empty()); assert_eq!(s.snapshot("id")["totalAverageTPS"], 50.0);
    }
    #[test] fn loss_invalidates_rates_and_compaction_never_tokenizes_ciphertext() {
        let encoder = tiktoken_rs::o200k_base().unwrap(); let mut s = sample();
        s.accept(10.0, Data::Event { response_id: None, compaction: true, flow: true, tool: None, output: None, terminal: None, invalid: false }, &encoder);
        s.accept(1000.0, event(None, Some("completed")), &encoder);
        assert_eq!(s.snapshot("id")["kind"], "compaction"); assert_eq!(s.snapshot("id")["toolTPS"], Value::Null);
        s.lost.store(true, Ordering::Relaxed); assert_eq!(s.snapshot("id")["totalAverageTPS"], Value::Null);
    }
    #[test] fn full_queue_does_not_block_or_panic() {
        let (sender, _rx) = mpsc::sync_channel(1);
        let observer = Observer { id: "test".into(), start: Instant::now(), lost: Arc::new(AtomicBool::new(false)), sender };
        observer.send(Data::End); observer.send(Data::End); assert!(observer.lost.load(Ordering::Relaxed));
    }
    #[test] fn generation_latency_includes_preparation_without_changing_request_rate_duration() {
        let encoder = tiktoken_rs::o200k_base().unwrap(); let mut s = sample();
        s.offset = Some(800.0);
        s.accept(200.0, event(None, None), &encoder);
        s.accept(1000.0, event(None, Some("completed")), &encoder);
        assert_eq!(s.snapshot("id")["firstStreamMs"], 1000.0);
        assert_eq!(s.snapshot("id")["requestFirstStreamMs"], 200.0);
        assert_eq!(s.snapshot("id")["totalAverageTPS"], 50.0);
        s.offset = None;
        assert_eq!(s.snapshot("id")["firstStreamMs"], Value::Null);
    }
    #[tokio::test] async fn generation_context_is_isolated_between_tasks_and_cleared_after_scope() {
        let make = |thread: &str| Arc::new(Generation { thread: thread.into(), turn: "turn".into(), id: thread.into(),
            start: Instant::now(), epoch: 1000.0, compaction: false });
        let a = make("a"); let b = make("b");
        let (left, right) = tokio::join!(
            GENERATION.scope(a, async { tokio::task::yield_now().await; current_generation().unwrap().thread.clone() }),
            GENERATION.scope(b, async { tokio::task::yield_now().await; current_generation().unwrap().thread.clone() })
        );
        assert_eq!(left, "a"); assert_eq!(right, "b"); assert!(current_generation().is_none());
    }

}
