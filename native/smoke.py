#!/usr/bin/env python3
"""Exercise native SSE via a loopback fixture, with dummy auth and an isolated Codex home."""
import http.server
import json
import os
import pathlib
import queue
import subprocess
import sys
import tempfile
import threading
import time

def run(binary, websocket=False):
    with tempfile.TemporaryDirectory(prefix='hud-native-fixture-') as temporary:
        root = pathlib.Path(temporary)
        requests = []
        generation = 0
        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def log_message(self, *args): pass
            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get('content-length', 0)))
                # The fixture forces uncompressed requests through API-key auth.
                body = json.loads(raw)
                requests.append({'path': self.path, 'headers': dict(self.headers), 'body': body})
                self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
                rid = f'resp_fixture_{len(requests)}'
                def emit(value):
                    self.wfile.write(('data: ' + json.dumps(value) + '\n\n').encode()); self.wfile.flush()
                self.respond(body, emit)
            def do_GET(self):
                import base64, hashlib, struct
                assert self.headers.get('Upgrade','').lower()=='websocket'
                key=self.headers['Sec-WebSocket-Key']
                self.send_response(101);self.send_header('Upgrade','websocket');self.send_header('Connection','Upgrade')
                self.send_header('Sec-WebSocket-Accept',base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode());self.end_headers()
                def frame(payload,opcode=1):
                    size=len(payload)
                    length=bytes([size]) if size<126 else b'\x7e'+struct.pack('!H',size) if size<65536 else b'\x7f'+struct.pack('!Q',size)
                    self.wfile.write(bytes([0x80|opcode])+length+payload);self.wfile.flush()
                def emit(value): frame(json.dumps(value).encode())
                while True:
                    header=self.rfile.read(2)
                    if len(header)<2:return
                    opcode=header[0]&15;size=header[1]&127
                    if size==126:size=struct.unpack('!H',self.rfile.read(2))[0]
                    if size==127:size=struct.unpack('!Q',self.rfile.read(8))[0]
                    assert size<=1024*1024 and header[1]&128
                    mask=self.rfile.read(4);payload=self.rfile.read(size)
                    payload=bytes(b^mask[i%4] for i,b in enumerate(payload))
                    if opcode==8:return
                    if opcode==9:frame(payload,10);continue
                    assert opcode==1 and header[0]&128
                    body=json.loads(payload)
                    requests.append({'path':self.path,'headers':dict(self.headers),'body':body})
                    self.respond(body,emit)
            def respond(self,body,emit):
                nonlocal generation
                rid = f'resp_fixture_{len(requests)}'
                emit({'type':'response.created','response':{'id':rid}})
                if body.get('generate') is False:
                    emit({'type':'response.completed','response':{'id':rid,'output':[], 'usage':{'input_tokens':0,'output_tokens':0,'total_tokens':0}}})
                    return
                generation+=1
                if generation == 1:
                    item = {'type':'function_call','id':'fc_fixture','call_id':'call_fixture','name':'hud_fixture_never_execute','arguments':''}
                    emit({'type':'response.output_item.added','item':item})
                    emit({'type':'response.function_call_arguments.delta','item_id':'fc_fixture','delta':'{"fixture":'})
                    time.sleep(.3)
                    emit({'type':'response.function_call_arguments.delta','item_id':'fc_fixture','delta':'"dummy"}'})
                    item['arguments'] = '{"fixture":"dummy"}'
                    emit({'type':'response.output_item.done','item':item})
                else:
                    item = {'type':'message','id':'msg_fixture','role':'assistant','content':[{'type':'output_text','text':'Fixture complete.'}]}
                    emit({'type':'response.output_item.added','item':{**item,'content':[]}})
                    emit({'type':'response.output_text.delta','item_id':'msg_fixture','delta':'Fixture complete.'})
                    emit({'type':'response.output_item.done','item':item})
                emit({'type':'response.completed','response':{'id':rid,'output':[item], 'usage':{'input_tokens':10,'output_tokens':20,'total_tokens':30}}})
        server = http.server.ThreadingHTTPServer(('127.0.0.1',0), Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        (root/'config.toml').write_text(f'''model = "gpt-test"
model_provider = "fixture"
[model_providers.fixture]
name = "Offline fixture"
base_url = "http://127.0.0.1:{server.server_port}/v1"
wire_api = "responses"
env_key = "HUD_FIXTURE_KEY"
supports_websockets = {str(websocket).lower()}
''')
        env = {**os.environ, 'CODEX_HOME': str(root), 'HUD_FIXTURE_KEY':'dummy-fixture-key',
               'CODEX_SPEED_HUD_NATIVE_DIR':str(root/'metrics'), 'RUST_LOG':'warn'}
        for key in ['OPENAI_API_KEY','CODEX_CLI_PATH','CODEX_INTERNAL_ORIGINATOR_OVERRIDE','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']:
            env.pop(key,None)
        proc = subprocess.Popen([binary,'app-server'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env=env)
        rows = queue.Queue()
        def read():
            for line in proc.stdout:
                try: rows.put(json.loads(line))
                except ValueError: pass
        threading.Thread(target=read,daemon=True).start()
        def send(value): proc.stdin.write(json.dumps(value)+'\n'); proc.stdin.flush()
        def wait(predicate):
            deadline=time.monotonic()+40
            while time.monotonic()<deadline:
                value=rows.get(timeout=max(.01,deadline-time.monotonic()))
                if value.get('error'): raise RuntimeError(str(value['error']))
                if predicate(value): return value
            raise RuntimeError('Fixture timed out')
        try:
            send({'id':1,'method':'initialize','params':{'clientInfo':{'name':'hud_offline_fixture','version':'1'},'capabilities':{'experimentalApi':True}}})
            initialization=wait(lambda v:v.get('id')==1)
            send({'method':'initialized'})
            send({'id':2,'method':'thread/start','params':{'model':'gpt-test','modelProvider':'fixture','cwd':str(root),'approvalPolicy':'never','sandbox':'danger-full-access'}})
            thread=wait(lambda v:v.get('id')==2)['result']['thread']['id']
            send({'id':3,'method':'turn/start','params':{'threadId':thread,'input':[{'type':'text','text':'Offline fixture only.','text_elements':[]}]}})
            turn=wait(lambda v:v.get('id')==3)['result']['turn']['id']
            completed=wait(lambda v:v.get('method')=='turn/completed')
            if completed['params']['turn']['status']!='completed': raise RuntimeError('Fixture turn failed')
            deadline=time.monotonic()+5
            samples=[]
            while time.monotonic()<deadline:
                samples=[json.loads(p.read_text()) for p in (root/'metrics').glob('*.json')]
                if len(samples)>=2 and all(v['status']=='completed' for v in samples): break
                time.sleep(.05)
            for sample in samples:
                assert sample['threadId']==thread and sample['turnId']==turn
                assert sample['firstStreamMs'] is not None and sample['source']=='native-observer'
                assert 'dummy' not in json.dumps(sample) and 'fixture-key' not in json.dumps(sample)
            if samples:
                assert len(samples)==2 and any(s['toolTPS'] is not None and s['toolTPS']>0 for s in samples)
            # Remove expected per-process/session randomness for comparison. Keep actual request logic.
            from urllib.parse import urlsplit
            for req in requests:
                dynamic_headers = ['host','sec-websocket-key','x-client-request-id','session-id','thread-id','session_id','conversation_id','x-codex-installation-id','x-codex-turn-metadata','x-codex-window-id','x-request-id','traceparent','tracestate']
                req['headers']={k.lower(): ('<dynamic>' if k.lower() in dynamic_headers else v) for k,v in req['headers'].items()}
                if 'prompt_cache_key' in req['body']: req['body']['prompt_cache_key']='<dynamic>'
                metadata=req['body'].get('client_metadata',{})
                for key in ['session_id','thread_id','turn_id','root_turn_id','installation_id','x-codex-installation-id','window_id','x-codex-window-id','context_window_id','x-codex-turn-metadata','turn_started_at_unix_ms','x-codex-ws-stream-request-start-ms']:
                    if key in metadata: metadata[key]='<dynamic>'
                for item in req['body'].get('input',[]):
                    if isinstance(item.get('id'),str) and item['id'].startswith(('msg_','fco_')): item['id']=item['id'].split('_')[0]+'_<dynamic>'
            return {'requests':requests,'initialization':initialization['result'], 'samples':len(samples), 'toolSamples':sum(s['toolTPS'] is not None for s in samples)}
        finally:
            proc.terminate()
            try: proc.wait(timeout=5)
            except subprocess.TimeoutExpired: proc.kill();proc.wait()
            server.shutdown()

if __name__=='__main__':
    websocket='--websocket' in sys.argv
    clients=[arg for arg in sys.argv[1:] if arg!='--websocket']
    observed=run(clients[0],websocket)
    if websocket: assert any(r['body'].get('type')=='response.create' for r in observed['requests']), 'No real WebSocket request observed'
    if len(clients)>1:
        original=run(clients[1],websocket)
        # Metadata also contains the temporary fixture cwd. Normalize that one value recursively.
        def normalize(value):
            if isinstance(value,dict): return {k:normalize(v) for k,v in value.items()}
            if isinstance(value,list): return [normalize(v) for v in value]
            if isinstance(value,str):
                import re
                return re.sub(r'/tmp/hud-native-fixture-[a-zA-Z0-9_-]+','/tmp/HUD_FIXTURE',value)
            return value
        assert normalize(observed['requests'])==normalize(original['requests']), 'Outgoing fixture requests differ from the original client'
        assert normalize(observed['initialization'])==normalize(original['initialization']), 'App Server identity/protocol differ'
        assert original['samples']==0 and observed['samples']>0
    print(json.dumps({'ok':True,'transport':'websocket' if websocket else 'sse','requests':len(observed['requests']),'nativeSamples':observed['samples'],'toolSamples':observed['toolSamples'],'realModelRequests':0}))
