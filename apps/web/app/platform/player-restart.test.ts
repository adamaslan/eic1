import {beforeEach,describe,expect,it} from 'vitest';
import {usePlayerStore} from './player-store';
const files = () => [new File(['a'],'a.wav',{type:'audio/wav'}),new File(['b'],'b.wav',{type:'audio/wav'})];
beforeEach(()=>{usePlayerStore.getState().resetAll();usePlayerStore.getState().loadFiles(files());});
describe('explicit playlist selection',()=>{
 for(const playing of [true,false]) it(`seeks the current song back to zero while playing=${playing}`,()=>{
  const store=usePlayerStore.getState();store.setPlaying(playing);store.tick(8,20);
  const file=usePlayerStore.getState().tracks[0]!.file;store.playAt(0);
  expect(usePlayerStore.getState()).toMatchObject({currentTime:0,seekTo:0,playing});
  expect(usePlayerStore.getState().tracks[0]!.file).toBe(file);
 });
 it('resets the pending seek when selecting another song',()=>{
  const store=usePlayerStore.getState();store.requestSeek(8);store.playAt(1);
  expect(usePlayerStore.getState()).toMatchObject({index:1,currentTime:0,seekTo:0});
 });
 it('lets saved-playlist resume replace the restart seek with the saved position',()=>{
  const store=usePlayerStore.getState();store.playAt(1);store.requestSeek(12);
  expect(usePlayerStore.getState()).toMatchObject({index:1,seekTo:12});
 });
 it('ignores an invalid row without disturbing playback or its pending seek',()=>{
  const store=usePlayerStore.getState();store.requestSeek(8);store.playAt(99);
  expect(usePlayerStore.getState()).toMatchObject({index:0,seekTo:8});
 });
});
