#!/usr/bin/env python3
"""Apply only observation hooks to one pinned official source revision. No network edits."""
import hashlib
import json
import pathlib
import sys

REVISION = '740e5af33c71225640e0c1c1555c514c2c93ab74'
root = pathlib.Path(sys.argv[1]).resolve()
rs = root / 'codex-rs'
here = pathlib.Path(__file__).resolve().parent

def replace(text, old, new):
    if text.count(old) != 1:
        raise SystemExit(f'Source mismatch: expected one occurrence of {old[:90]!r}; refusing to patch')
    return text.replace(old, new)

originals = {}
def load(name):
    p = rs / name
    originals[name] = p.read_text()
    return originals[name]

changes = {}
t = load('codex-api/src/lib.rs')
changes['codex-api/src/lib.rs'] = replace(t, 'pub(crate) mod sse;', 'pub(crate) mod sse;\npub mod speed_observer;')
t = load('codex-api/Cargo.toml')
changes['codex-api/Cargo.toml'] = replace(t, '[dependencies]\n', '[dependencies]\ntiktoken-rs = "=0.9.1"\n')
t = load('codex-api/src/endpoint/responses.rs')
t = replace(t, '        let ResponsesOptions {', '''        let metadata = request.client_metadata.as_ref();
        let observer = crate::speed_observer::Observer::begin(
            metadata.and_then(|m| m.get("thread_id")).map(String::as_str),
            metadata.and_then(|m| m.get("turn_id")).map(String::as_str),
            &request.model, false, crate::speed_observer::current_generation(),
        );
        let ResponsesOptions {''')
t = replace(t, 'self.stream_encoded(body, headers, compression, turn_state)', 'self.stream_encoded(body, headers, compression, turn_state, observer)')
t = replace(t, '        let body = EncodedJsonBody::encode(&body)', '''        let observer = crate::speed_observer::Observer::begin(
            body.pointer("/client_metadata/thread_id").and_then(Value::as_str),
            body.pointer("/client_metadata/turn_id").and_then(Value::as_str),
            body.get("model").and_then(Value::as_str).unwrap_or("unknown"), false, crate::speed_observer::current_generation(),
        );
        let body = EncodedJsonBody::encode(&body)''')
t = replace(t, 'self.stream_encoded(body, extra_headers, compression, turn_state)', 'self.stream_encoded(body, extra_headers, compression, turn_state, observer)')
t = replace(t, '''    async fn stream_encoded(
        &self,
        body: EncodedJsonBody,
        extra_headers: HeaderMap,
        compression: Compression,
        turn_state: Option<Arc<OnceLock<String>>>,''', '''    async fn stream_encoded(
        &self,
        body: EncodedJsonBody,
        extra_headers: HeaderMap,
        compression: Compression,
        turn_state: Option<Arc<OnceLock<String>>>,
        observer: Option<crate::speed_observer::Observer>,''')
t = replace(t, 'Ok(spawn_response_stream(', 'Ok(crate::sse::responses::spawn_observed_response_stream(')
t = replace(t, '            turn_state,\n        ))', '            turn_state,\n            observer,\n        ))')
t = replace(t, 'use crate::sse::spawn_response_stream;\n', '')
changes['codex-api/src/endpoint/responses.rs'] = t
t = load('codex-api/src/sse/responses.rs')
signature = '''pub fn spawn_response_stream(
    stream_response: StreamResponse,
    idle_timeout: Duration,
    telemetry: Option<Arc<dyn SseTelemetry>>,
    turn_state: Option<Arc<OnceLock<String>>>,
) -> ResponseStream {'''
t = replace(t, signature, signature + '''
    spawn_observed_response_stream(stream_response, idle_timeout, telemetry, turn_state, None)
}

pub(crate) fn spawn_observed_response_stream(
    stream_response: StreamResponse,
    idle_timeout: Duration,
    telemetry: Option<Arc<dyn SseTelemetry>>,
    turn_state: Option<Arc<OnceLock<String>>>,
    observer: Option<crate::speed_observer::Observer>,
) -> ResponseStream {''')
t = replace(t, '            safety_buffering_treatment,\n        )', '            safety_buffering_treatment,\n            observer,\n        )')
t = replace(t, '        SafetyBufferingTreatment::default(),\n    )', '        SafetyBufferingTreatment::default(),\n        None,\n    )')
t = replace(t, '    safety_buffering_treatment: SafetyBufferingTreatment,\n) {', '    safety_buffering_treatment: SafetyBufferingTreatment,\n    observer: Option<crate::speed_observer::Observer>,\n) {')
t = replace(t, 'impl ResponsesStreamEvent {', '''impl ResponsesStreamEvent {
    pub(crate) fn observe_speed(&self, observer: &crate::speed_observer::Observer) {
        observer.event(&self.kind, self.response.as_ref(), self.item.as_ref(),
            self.item_id.as_deref(), self.call_id.as_deref(), self.delta.as_deref());
    }''')
t = replace(t, '        let model_verifications = event.model_verifications();', '''        if let Some(observer) = observer.as_ref() {
            observer.event(&event.kind, event.response.as_ref(), event.item.as_ref(),
                event.item_id.as_deref(), event.call_id.as_deref(), event.delta.as_deref());
        }
        let model_verifications = event.model_verifications();''')
changes['codex-api/src/sse/responses.rs'] = t
t = load('codex-api/src/endpoint/responses_websocket.rs')
t = replace(t, 'struct ResponsesWebsocketTimingLogContext {', 'struct ResponsesWebsocketTimingLogContext {\n    generation: Option<Arc<crate::speed_observer::Generation>>,')
t = replace(t, '        let timing_log_context = ResponsesWebsocketTimingLogContext {', '        let timing_log_context = ResponsesWebsocketTimingLogContext {\n            generation: crate::speed_observer::current_generation(),')
t = replace(t, '    let mut last_server_model: Option<String> = None;', '''    let observer = crate::speed_observer::Observer::begin(
        timing_log_context.thread_id.as_deref(), timing_log_context.turn_id.as_deref(),
        &timing_log_context.model, timing_log_context.warmup, timing_log_context.generation.clone(),
    );
    let mut last_server_model: Option<String> = None;''')
t = replace(t, '                emit_responses_websocket_timing_event(', '''                if let Some(observer) = observer.as_ref() {
                    event.observe_speed(observer);
                }
                emit_responses_websocket_timing_event(''')
changes['codex-api/src/endpoint/responses_websocket.rs'] = t


# Core task triggers, before prompt preparation/connection acquisition. Context is
# task-local and explicitly carried into the WS worker, never a request field.
t = load('core/src/turn_timing.rs')
t = replace(t, '    first_token_at: Option<Instant>,', '    first_token_at: Option<Instant>,\n    speed_generation_seen: bool,')
t = replace(t, '        state.first_token_at = None;', '        state.first_token_at = None;\n        state.speed_generation_seen = false;')
t = replace(t, '    pub(crate) async fn started_at_unix_secs', """    pub(crate) async fn speed_generation_start(&self) -> Instant {
        let now = Instant::now();
        if std::env::var_os("CODEX_SPEED_HUD_NATIVE_DIR").is_none() { return now; }
        let mut state = self.state.lock().await;
        let start = if state.speed_generation_seen { now } else { state.started_at.unwrap_or(now) };
        state.speed_generation_seen = true;
        start
    }

    pub(crate) async fn started_at_unix_secs""")
changes['core/src/turn_timing.rs'] = t

def wrap_generation(name, function, turn_expr, arguments, compaction):
    import re
    text = load(name)
    match = re.search(r'async fn ' + function + r'\([\s\S]*?\n\) -> [^\n]+ \{', text)
    if not match: raise SystemExit('Generation task signature mismatch: ' + function)
    header = match.group()
    wrapper_header = header.replace('async fn run_sampling_request(', 'async fn run_sampling_request(\n    speed_start: std::time::Instant,') if function == 'run_sampling_request' else header
    anchor = 'speed_start' if function == 'run_sampling_request' else f'{turn_expr}.turn_timing_state.speed_generation_start().await'
    wrapper = wrapper_header + f"""
    let start = {anchor};
    let thread = sess.thread_id.to_string();
    let turn = {turn_expr}.sub_id.clone();
    codex_api::speed_observer::scope_generation(&thread, &turn, start, {str(compaction).lower()},
        {function}_without_speed_scope({arguments})).await
}}

"""
    changes[name] = text[:match.start()] + wrapper + text[match.start():].replace('async fn ' + function + '(', 'async fn ' + function + '_without_speed_scope(', 1)

wrap_generation('core/src/session/turn.rs', 'run_sampling_request', 'step_context.turn',
    'sess, step_context, turn_store, turn_diff_tracker, client_session, input, cancellation_token', False)
wrap_generation('core/src/compact.rs', 'run_compact_task_inner', 'turn_context',
    'sess, turn_context, replacement_step_context, input, world_state, compaction_metadata', True)
wrap_generation('core/src/compact_remote_v2.rs', 'run_remote_compact_task_inner', 'step_context.turn',
    'sess, step_context, replacement_step_context, client_session, world_state, compaction_metadata', True)

changes['core/src/session/turn.rs'] = replace(changes['core/src/session/turn.rs'],
    '    loop {\n        // Note that pending_input',
    '    loop {\n        let speed_start = turn_context.turn_timing_state.speed_generation_start().await;\n        // Note that pending_input')
changes['core/src/session/turn.rs'] = replace(changes['core/src/session/turn.rs'],
    '            run_sampling_request(\n                Arc::clone(&sess),',
    '            run_sampling_request(\n                speed_start,\n                Arc::clone(&sess),')

# Validate all before writing. The builder checks original file hashes from the manifest.
for name, text in changes.items():
    (rs / name).write_text(text)
(rs / 'codex-api/src/speed_observer.rs').write_text((here / 'observer.rs').read_text())
(root / 'speed-observer-patch.json').write_text(json.dumps({ 'revision': REVISION, 'patchRevision': 2,
    'observerSha256': hashlib.sha256((here / 'observer.rs').read_bytes()).hexdigest(),
    'files': {name: {'before': hashlib.sha256(originals[name].encode()).hexdigest(),
                    'after': hashlib.sha256(text.encode()).hexdigest()} for name, text in changes.items()} }, indent=2))
print('Applied read-only native observation hooks; request serialization and transport implementations untouched.')
