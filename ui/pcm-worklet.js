// Preserve the device sample rate; the local engine owns resampling.
class PCMProcessor extends AudioWorkletProcessor {
  constructor(){super();this.packet=[];this.active=true;this.port.onmessage=e=>{if(e.data==='flush'){this.emit();this.active=false;this.port.postMessage({type:'flushed'});}};}
  emit(){if(!this.packet.length)return;const pcm=new Int16Array(this.packet);this.port.postMessage({type:'pcm',buffer:pcm.buffer},[pcm.buffer]);this.packet=[];}
  process(inputs){if(!this.active)return false;const channels=inputs[0];if(!channels?.length)return true;for(let i=0;i<channels[0].length;i++){let v=0;for(const c of channels)v+=c[i];v=Math.max(-1,Math.min(1,v/channels.length));this.packet.push(Math.round(v*(v<0?32768:32767)));if(this.packet.length>=Math.round(sampleRate/10))this.emit();}return true;}
}
registerProcessor('pcm-capture',PCMProcessor);
