import {beforeEach,describe,expect,it} from 'vitest';
import {usePlayerStore} from './player-store';
const state=()=>usePlayerStore.getState();
beforeEach(()=>{state().resetAll();state().loadFiles(['a','b','c'].map(n=>new File([n],n+'.wav',{type:'audio/wav'})));state().tick(2,20);state().cycleAB();state().tick(4,20);state().cycleAB();});
const cleared=()=>expect(state()).toMatchObject({abA:null,abB:null});
const retained=()=>expect(state()).toMatchObject({abA:2,abB:4});
describe('track scoped A-B loop',()=>{
 it('clears on selecting another song',()=>{state().playAt(1);cleared();});
 it('clears on next',()=>{state().move(1,false);cleared();});
 it('clears on queued song',()=>{state().playNext(2);state().move(1,false);cleared();});
 it('clears on removing current song',()=>{state().removeTrack(0);cleared();});
 it('clears on replacing current audio',()=>{const t=state().tracks[0]!;state().replaceTrack(0,{...t,file:new File(['x'],'x.wav')});cleared();});
 it('retains on reselecting the same song',()=>{state().playAt(0);retained();});
 it('retains on song repeat',()=>{state().cycleRepeat();state().move(1,true);retained();});
 it('retains on reordering the current song',()=>{state().reorderTrack(0,1);retained();});
 it('retains on removing another song',()=>{state().removeTrack(2);retained();});
 it('retains on metadata-only replacement',()=>{state().replaceTrack(0,{...state().tracks[0]!,starred:true});retained();});
});
