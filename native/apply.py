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
changes['codex-api/src/lib.rs'] = replace(t, 'pub(crate) mod sse;', 'pub(crate) mod sse;\nmod speed_observer;')
t = load('codex-api/Cargo.toml')
changes['codex-api/Cargo.toml'] = replace(t, '[dependencies]\n', '[dependencies]\ntiktoken-rs = "=0.9.1"\n')
t = load('codex-api/src/endpoint/responses.rs')
t = replace(t, '        let ResponsesOptions {', '''        let metadata = request.client_metadata.as_ref();
        let observer = crate::speed_observer::Observer::begin(
            metadata.and_then(|m| m.get("thread_id")).map(String::as_str),
            metadata.and_then(|m| m.get("turn_id")).map(String::as_str),
            &request.model, false,
        );
        let ResponsesOptions {''')
t = replace(t, 'self.stream_encoded(body, headers, compression, turn_state)', 'self.stream_encoded(body, headers, compression, turn_state, observer)')
t = replace(t, '        let body = EncodedJsonBody::encode(&body)', '''        let observer = crate::speed_observer::Observer::begin(
            body.pointer("/client_metadata/thread_id").and_then(Value::as_str),
            body.pointer("/client_metadata/turn_id").and_then(Value::as_str),
            body.get("model").and_then(Value::as_str).unwrap_or("unknown"), false,
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
t = replace(t, '    let mut last_server_model: Option<String> = None;', '''    let observer = crate::speed_observer::Observer::begin(
        timing_log_context.thread_id.as_deref(), timing_log_context.turn_id.as_deref(),
        &timing_log_context.model, timing_log_context.warmup,
    );
    let mut last_server_model: Option<String> = None;''')
t = replace(t, '                emit_responses_websocket_timing_event(', '''                if let Some(observer) = observer.as_ref() {
                    event.observe_speed(observer);
                }
                emit_responses_websocket_timing_event(''')
changes['codex-api/src/endpoint/responses_websocket.rs'] = t

# Validate all before writing. The builder checks original file hashes from the manifest.
for name, text in changes.items():
    (rs / name).write_text(text)
(rs / 'codex-api/src/speed_observer.rs').write_text((here / 'observer.rs').read_text())
(root / 'speed-observer-patch.json').write_text(json.dumps({ 'revision': REVISION,
    'files': {name: {'before': hashlib.sha256(originals[name].encode()).hexdigest(),
                    'after': hashlib.sha256(text.encode()).hexdigest()} for name, text in changes.items()} }, indent=2))
print('Applied read-only native observation hooks; request serialization and transport implementations untouched.')
