import {describe,expect,it} from 'vitest';
import {matchSavedToPicked,SavedPlaylistSchema} from './music';
const saved=(tracks:{name:string,path?:string}[])=>SavedPlaylistSchema.parse({format:'eic-playlist',version:1,name:'Mix',savedAt:'2026-11-25T00:00:00Z',tracks});
describe('folder playlist relinking',()=>{
 it('reopens a folder-saved track from a unique loose File',()=>{expect(matchSavedToPicked(saved([{name:'song.wav',path:'mix/song.wav'}]),[new File(['x'],'song.wav')]).mapping).toEqual([0]);});
 it('reads real File webkitRelativePath before falling back to its name',()=>{const a=new File(['a'],'song.wav');const b=new File(['b'],'song.wav');Object.defineProperty(a,'webkitRelativePath',{value:'other/song.wav'});Object.defineProperty(b,'webkitRelativePath',{value:'mix/song.wav'});expect(matchSavedToPicked(saved([{name:'song.wav',path:'mix/song.wav'}]),[a,b]).mapping).toEqual([1]);});
 it('does not attach a different known folder with the same bare name',()=>{expect(matchSavedToPicked(saved([{name:'song.wav',path:'mix/song.wav'}]),[{name:'song.wav',type:'audio/wav',path:'other/song.wav'}]).mapping).toEqual([null]);});
 it('keeps duplicate saved basenames unresolved for loose picks',()=>{expect(matchSavedToPicked(saved([{name:'song.wav',path:'a/song.wav'},{name:'song.wav',path:'b/song.wav'}]),[new File(['x'],'song.wav')]).mapping).toEqual([null,null]);});
 it('keeps ambiguous loose picks unresolved',()=>{expect(matchSavedToPicked(saved([{name:'song.wav',path:'mix/song.wav'}]),[new File(['a'],'song.wav'),new File(['b'],'song.wav')]).mapping).toEqual([null]);});
 it('preserves exact path priority and missing order without mutating inputs',()=>{const s=saved([{name:'SONG.wav',path:'mix/SONG.wav'},{name:'gone.wav'}]);const p=[{name:'song.wav',type:'audio/wav',path:'mix/song.wav'}];const before=structuredClone({s,p});expect(matchSavedToPicked(s,p)).toEqual({mapping:[0,null],missing:['gone.wav']});expect({s,p}).toEqual(before);});
});
