import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app=fs.readFileSync(new URL('../ui/app.js',import.meta.url),'utf8');
const worklet=fs.readFileSync(new URL('../ui/pcm-worklet.js',import.meta.url),'utf8');
const tick=()=>new Promise(setImmediate);

function harness(initial={ready:true,status:'ready',device:'cuda:0'},desktopMode=false){
  const states=[],finals=[];let command,statusCallback,resolveMicrophone;
  const bridge={onCommand:cb=>command=cb,onStatus:cb=>statusCallback=cb,reportState:event=>states.push(event),reportFinal:event=>finals.push(event)};
  const elements=new Map(),listeners=new Map(),sockets=[];let status=initial,trackStops=0,requests=0;
  const el=id=>{if(!elements.has(id))elements.set(id,{textContent:'',value:'',hidden:false,disabled:false,classList:{toggle(){}},addEventListener(n,f){this[n]=f;}});return elements.get(id);};
  class WS{static OPEN=1;constructor(){sockets.push(this);this.readyState=1;this.sent=[];this.bufferedAmount=0;}send(v){this.sent.push(v);}close(){this.readyState=3;}}
  class AC{constructor(){this.sampleRate=48000;this.state='running';this.audioWorklet={addModule:async()=>{}};this.destination={};}async resume(){}createMediaStreamSource(){return{connect(){},disconnect(){}};}createGain(){return{gain:{},connect(){},disconnect(){}};}async close(){this.state='closed';}}
  class AW{constructor(){this.port={postMessage:()=>{this.port.onmessage({data:{type:'flushed'}});}};}connect(){}disconnect(){}}
  let clock=1000,timerClock=0,nextTimer=1;const timers=new Map();
  const setTimer=(fn,delay)=>{const id=nextTimer++;timers.set(id,{fn,at:timerClock+delay});return id;};
  const advance=ms=>{const end=timerClock+ms;while(true){const next=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;timerClock=next[1].at;timers.delete(next[0]);next[1].fn();}clock+=ms;timerClock=end;};
  const context={document:{getElementById:el},navigator:{mediaDevices:{getUserMedia:async()=>{requests++;return{getTracks:()=>[{stop(){trackStops++;}}]};}},clipboard:{writeText:async()=>{}}},location:{protocol:'http:',host:'localhost:8765'},AudioContext:AC,AudioWorkletNode:AW,WebSocket:WS,performance:{now:()=>clock+=100},fetch:async()=>({ok:true,json:async()=>status}),setTimeout:setTimer,clearTimeout:id=>timers.delete(id),setInterval(){},window:{quillkey:desktopMode?bridge:undefined,addEventListener:(name,fn)=>listeners.set(name,fn)}};
  vm.createContext(context);vm.runInContext(app,context);
  return{el,sockets,listeners,states,finals,advance,get pendingTimers(){return timers.size;},command:event=>command(event),shellStatus:event=>statusCallback(event),deferMicrophone(){context.navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>resolveMicrophone=resolve);},resolveMicrophone(){resolveMicrophone({getTracks:()=>[{stop(){trackStops++;}}]});},get requests(){return requests;},get trackStops(){return trackStops;},setStatus(value){status=value;return vm.runInContext('checkStatus()',context);},event(ws,m){ws.onmessage({data:JSON.stringify(m)});}};
}

test('PCM preserves samples, mixes channels and flushes tail at supported device rates',()=>{
  for(const rate of [16000,44100,48000,96000]){
    let C;const sent=[];
    vm.runInNewContext(worklet,{sampleRate:rate,Int16Array,Math,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>sent.push(m)};}},registerProcessor:(name,c)=>C=c});
    const p=new C();let count=0;
    for(let i=0;i<37;i++){assert.equal(p.process([[new Float32Array(128).fill(1),new Float32Array(128).fill(-.5)]]),true);count+=128;}
    p.port.onmessage({data:'flush'});
    const pcm=sent.filter(m=>m.type==='pcm').flatMap(m=>[...new Int16Array(m.buffer)]);
    assert.equal(pcm.length,count);assert.ok(pcm.every(v=>v===8192));assert.equal(sent.at(-1).type,'flushed');assert.equal(p.process([]),false);
  }
});

test('session negotiates native rate, preserves endpointed segments and awaits commit acknowledgement',async()=>{
  const h=harness();await tick();assert.equal(h.requests,0);
  await h.el('start').click();await h.el('start').click();assert.equal(h.requests,1);
  const ws=h.sockets[0];ws.onopen();assert.equal(JSON.parse(ws.sent[0]).session.sample_rate,48000);
  h.event(ws,{type:'session.updated'});assert.equal(h.el('transcript').readOnly,true);
  h.event(ws,{type:'conversation.item.input_audio_transcription.delta',delta:'hello'});assert.equal(h.el('live-text').textContent,'hello');assert.equal(h.el('transcript').value,'');
  h.event(ws,{type:'conversation.item.input_audio_transcription.completed',transcript:'Hello.'});h.event(ws,{type:'conversation.item.input_audio_transcription.completed',transcript:'Second sentence.'});assert.equal(h.el('transcript').value,'Hello.\nSecond sentence.');
  h.el('stop').click();assert.equal(JSON.parse(ws.sent.at(-1)).type,'input_audio_buffer.commit');assert.equal(ws.readyState,1);
  h.event(ws,{type:'input_audio_buffer.committed'});assert.equal(ws.readyState,3);assert.ok(h.trackStops>0);assert.equal(h.el('transcript').readOnly,false);
});

test('Escape cancels and stale socket events cannot alter the next session',async()=>{
  const h=harness();await tick();await h.el('start').click();const old=h.sockets[0];old.onopen();h.event(old,{type:'session.updated'});
  let prevented=false;h.listeners.get('keydown')({key:'Escape',preventDefault(){prevented=true;}});assert.ok(prevented);assert.equal(old.readyState,3);assert.ok(h.trackStops>0);
  await h.el('start').click();const next=h.sockets[1];next.onopen();h.event(next,{type:'session.updated'});h.event(old,{type:'conversation.item.input_audio_transcription.completed',transcript:'stale text'});assert.equal(h.el('transcript').value,'');
});

test('readiness reports actual device, loading, errors and other active clients',async()=>{
  const h=harness();await tick();assert.match(h.el('readiness').textContent,/cuda:0/);assert.equal(h.el('start').disabled,false);
  await h.setStatus({ready:false,status:'loading',device:null});assert.match(h.el('state-description').textContent,/Loading/);assert.equal(h.el('start').disabled,true);assert.doesNotMatch(h.el('readiness').textContent,/cuda/);
  await h.setStatus({ready:false,status:'error',error:'Model missing'});assert.equal(h.el('state-description').textContent,'Model missing');assert.match(h.el('readiness').textContent,/error/);
  await h.setStatus({ready:true,status:'ready',busy:true,device:'cpu'});assert.equal(h.el('start').disabled,true);assert.match(h.el('readiness').textContent,/in use.*cpu/);
});


test('desktop quick release cancels pending microphone and ignores stale commands',async()=>{
  const h=harness(undefined,true);await tick();h.deferMicrophone();
  h.command({type:'start',sessionId:'quick'});h.command({type:'stop',sessionId:'quick'});
  assert.equal(h.states.at(-1).status,'cancelled');h.resolveMicrophone();await tick();
  assert.equal(h.sockets.length,0);assert.ok(h.trackStops>0);assert.equal(h.finals.length,0);
});

test('desktop final is reported once, stale release ignored, insertion failure keeps text',async()=>{
  const h=harness(undefined,true);await tick();h.command({type:'start',sessionId:'one'});await tick();
  const ws=h.sockets[0];ws.onopen();h.event(ws,{type:'session.updated'});
  h.command({type:'stop',sessionId:'old'});assert.equal(h.states.at(-1).status,'recording');
  h.event(ws,{type:'conversation.item.input_audio_transcription.delta',delta:'a'.repeat(3000)});
  assert.equal(h.states.at(-1).text.length,2000);
  h.event(ws,{type:'conversation.item.input_audio_transcription.completed',transcript:'Keep this.'});
  h.command({type:'stop',sessionId:'one'});h.event(ws,{type:'input_audio_buffer.committed'});h.event(ws,{type:'input_audio_buffer.committed'});
  assert.equal(h.finals.length,1);assert.equal(h.finals[0].text,'Keep this.');assert.equal(h.states.at(-1).status,'ready');
  h.shellStatus({type:'insertion-result',sessionId:'one',ok:false,message:'Target unavailable'});
  assert.equal(h.el('transcript').value,'Keep this.');assert.equal(h.el('error').textContent,'Target unavailable');
  await h.el('start').click();const manual=h.sockets[1];manual.onopen();h.event(manual,{type:'session.updated'});h.el('stop').click();h.event(manual,{type:'input_audio_buffer.committed'});assert.equal(h.finals.length,1);
});

test('desktop release during socket setup terminates before recording',async()=>{
  const h=harness(undefined,true);await tick();h.command({type:'start',sessionId:'setup'});await tick();
  const ws=h.sockets[0];h.command({type:'stop',sessionId:'setup'});h.event(ws,{type:'session.updated'});
  assert.equal(ws.readyState,3);assert.equal(h.states.at(-1).status,'cancelled');assert.equal(h.finals.length,0);
});


test('desktop errors terminate lifecycle and retain completed speech',async()=>{
  const h=harness(undefined,true);await tick();h.command({type:'start',sessionId:'error'});await tick();
  const ws=h.sockets[0];ws.onopen();h.event(ws,{type:'session.updated'});
  h.event(ws,{type:'conversation.item.input_audio_transcription.completed',transcript:'Saved segment'});
  h.event(ws,{type:'error',message:'Engine stopped'});
  assert.equal(h.states.at(-1).status,'error');assert.equal(h.states.at(-1).message,'Engine stopped');
  assert.equal(h.el('transcript').value,'Saved segment');assert.equal(h.finals.length,0);assert.ok(h.trackStops>0);
});


test('desktop startup readiness explains unavailable shortcut without disabling dashboard recording',async()=>{
  const h=harness(undefined,true);await tick();
  h.shellStatus({nativeReady:false,message:'Global shortcut is already in use.'});
  assert.match(h.el('mic-note').textContent,/already in use.*Start recording and Copy text/);
  assert.equal(h.el('start').disabled,false);
  await h.el('start').click();const ws=h.sockets[0];ws.onopen();h.event(ws,{type:'session.updated'});
  h.event(ws,{type:'conversation.item.input_audio_transcription.completed',transcript:'Manual recording'});
  h.el('stop').click();h.event(ws,{type:'input_audio_buffer.committed'});
  assert.equal(h.el('copy').disabled,false);assert.equal(h.finals.length,0);
  h.shellStatus({nativeReady:true});assert.match(h.el('mic-note').textContent,/Hold Ctrl\+Alt\+Space/);
});


test('30 minute recording starts its limit at readiness and automatically commits final once',async()=>{
  const h=harness(undefined,true);await tick();h.command({type:'start',sessionId:'long'});await tick();
  const ws=h.sockets[0];ws.onopen();h.advance(19000);h.event(ws,{type:'session.updated'});
  assert.match(h.el('state-description').textContent,/30 minutes/);
  h.advance(126000);assert.equal(h.states.at(-1).status,'recording');assert.equal(ws.readyState,1);
  h.event(ws,{type:'conversation.item.input_audio_transcription.completed',transcript:'Early segment.'});
  h.advance(30*60*1000-126000-1);assert.equal(h.states.at(-1).status,'recording');
  h.advance(1);assert.equal(h.states.at(-1).status,'processing');assert.ok(h.trackStops>0);
  assert.equal(ws.sent.filter(message=>typeof message==='string'&&JSON.parse(message).type==='input_audio_buffer.commit').length,1);
  h.command({type:'stop',sessionId:'long'});
  h.event(ws,{type:'conversation.item.input_audio_transcription.completed',transcript:'Final tail.'});
  h.event(ws,{type:'input_audio_buffer.committed'});h.event(ws,{type:'input_audio_buffer.committed'});
  assert.equal(h.finals.length,1);assert.equal(h.finals[0].text,'Early segment.\nFinal tail.');
  assert.equal(h.states.at(-1).status,'ready');assert.equal(h.pendingTimers,0);
});

test('manual stop, cancellation and disposal clear the recording limit timer',async()=>{
  for(const action of ['stop','cancel','error','unload']){
    const h=harness(undefined,true);await tick();h.command({type:'start',sessionId:action});await tick();
    const ws=h.sockets[0];ws.onopen();h.event(ws,{type:'session.updated'});assert.equal(h.pendingTimers,1);
    if(action==='error')h.event(ws,{type:'error',message:'Engine stopped'});
    else if(action==='unload')h.listeners.get('beforeunload')();
    else h.command({type:action,sessionId:action});
    if(action==='stop')h.event(ws,{type:'input_audio_buffer.committed'});
    assert.equal(h.pendingTimers,0);
    const count=h.states.length;h.advance(31*60*1000);assert.equal(h.states.length,count);
  }
});
