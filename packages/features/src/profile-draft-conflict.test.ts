import {it,expect} from 'vitest';
import {createVault} from '@veil/vault';
import {SubtleCryptoPort} from '@veil/crypto';
import {MemoryStore} from '../../vault/src/memory-store';
import {defaultSettings,saveSettings} from './social';
import {loadProfileDraft,saveProfileDraft} from './profile-studio';
it('a stale private editor cannot silently replace a newer saved draft',async()=>{
 const now=new Date('2026-11-25T08:00:00Z');const vault=await createVault({store:new MemoryStore(),crypto:new SubtleCryptoPort(),now:()=>now},'synthetic-private-conflict');await saveSettings(vault,{...defaultSettings(),authorId:'alice',handle:'alice'});
 const first=await loadProfileDraft(vault),stale=await loadProfileDraft(vault);first.song='latest private song';await saveProfileDraft(vault,first);stale.book='stale editor book';await expect(saveProfileDraft(vault,stale)).rejects.toThrow(/changed|another|latest/);expect((await loadProfileDraft(vault)).song).toBe('latest private song');
});
it('returned revision permits repeat saves, and two simultaneous first saves have one winner',async()=>{
 const now=new Date('2026-11-25T08:00:00Z');const vault=await createVault({store:new MemoryStore(),crypto:new SubtleCryptoPort(),now:()=>now},'synthetic-profile-race');await saveSettings(vault,{...defaultSettings(),authorId:'alice',handle:'alice'});
 const left=await loadProfileDraft(vault),right=await loadProfileDraft(vault);left.song='left';right.song='right';const results=await Promise.allSettled([saveProfileDraft(vault,left),saveProfileDraft(vault,right)]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);const current=await loadProfileDraft(vault);expect(current.revision).toBe(1);current.book='next book';const next=await saveProfileDraft(vault,current);expect(next.revision).toBe(2);expect((await loadProfileDraft(vault)).book).toBe('next book');
});
it('legacy draft without a revision upgrades without losing private fields',async()=>{
 const now=new Date('2026-11-25T08:00:00Z');const vault=await createVault({store:new MemoryStore(),crypto:new SubtleCryptoPort(),now:()=>now},'synthetic-profile-legacy');await saveSettings(vault,{...defaultSettings(),authorId:'alice',handle:'alice'});const draft=await loadProfileDraft(vault);const {revision,...legacy}=draft;void revision;legacy.song='legacy private song';await vault.putJson('settings','profile-studio:alice',legacy);const loaded=await loadProfileDraft(vault);expect(loaded.revision).toBe(0);const saved=await saveProfileDraft(vault,loaded);expect(saved.song).toBe('legacy private song');expect(saved.revision).toBe(1);
});
