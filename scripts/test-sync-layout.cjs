const fs = require('fs');
// Opt-in visual acceptance in a marked, disposable Obsidian vault. No live Connect calls.
const path = require('path');
const cdpUrl = process.env.MDBASE_UX_CDP_URL;
const vault = process.env.MDBASE_UX_VAULT;
const shots = process.env.MDBASE_UX_SHOTS;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl || '') || !vault || !shots
    || !fs.existsSync(path.join(vault, '.obsidian', 'mdbase-ux-disposable'))) {
 throw Error('Set MDBASE_UX_CDP_URL, MDBASE_UX_VAULT and MDBASE_UX_SHOTS for a marked disposable vault; see docs/sync-ux-acceptance.md');
}
const { chromium } = require(process.env.MDBASE_UX_PLAYWRIGHT || '@playwright/test');
const prefix = process.argv[2] || 'sync-layout';
fs.mkdirSync(shots, {recursive:true});
(async () => {
 const browser = await chromium.connectOverCDP(cdpUrl);
 const page = browser.contexts()[0].pages().find(p => p.url().startsWith('app://'));
 if (await page.evaluate(() => app.vault.adapter.basePath) !== vault) throw Error('Wrong disposable vault');
 await page.evaluate(async()=>{
   await app.plugins.disablePlugin('mdbase-obsidian'); await app.plugins.enablePlugin('mdbase-obsidian');
   const p=app.plugins.plugins['mdbase-obsidian'];
   p.syncScheduler.stop();p.settings.autoSync=false;p.settings.mirrorProfile=null;
   p.connectSync.status=async()=>p.sync.state.status;
   p.sync.historyRuns=()=>window.fixtureRuns||[];
   window.uxView=await p.openWorkspace('sync');
   app.workspace.leftSplit.collapse();app.workspace.rightSplit.collapse();
   window.open=()=>null;
 });
 const states=['healthy','offline','auth','copied','paused','internal','progress','first-sync','deletions','rebuild','conflict','history','enrollment','upload'];
 const results=[];
 for(const state of states) {
  await page.evaluate(state=>{
   const p=app.plugins.plugins['mdbase-obsidian'], view=uxView;
   const longPath='Projects/ExtremelyLongFilenameWithoutSpacesOrBreaks_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ.md';
   p.settings.mirrorProfile={name:'Project notes',collectionId:'ux-fixture',replicaId:'ux-device',mode:'read_write',controlUrl:'https://connect.example',syncUrl:'https://connect.example',enrollmentId:'ux-fixture',accessTokenExpiresAt:'2099-01-01T00:00:00Z',selectiveSync:{file_classes:[],excluded_folders:[]}};
   p.sync.reset();view.busy=false;view.message='';view.schema=null;view.destination='sync';
   view.sync.enrollmentVerification='';view.sync.enrollmentAbort=null;view.sync.conflictComparisons.clear();
   view.sync.transferQuery='';view.sync.transferFilter='all';view.disclosures.clear();window.fixtureRuns=[];
   p.sync.update({status:{state:'up_to_date',last_synced_at:new Date().toISOString(),conflicts:[],local_issues:[],pending:0}});
   const problems={
    offline:{kind:'offline',title:"Can't reach mdbase Connect",message:'Your changes are saved on this device and sync automatically when the connection returns.',action:'retry',actionLabel:'Retry now'},
    auth:{kind:'auth',title:'Connect approval is required again',message:'Your local files and mirror checkpoint are safe. Approve this vault again to restore access.',action:'reauthorize',actionLabel:'Sign in again'},
    copied:{kind:'device',title:'Set up sync on this device',message:"This vault's sync settings came from another device or another copy of the vault. Approve this copy to give it its own connection. Your files stay as they are.",action:'reauthorize',actionLabel:'Set up this device'},
    internal:{kind:'internal',title:'Sync stopped unexpectedly',message:'An unexpected error stopped synchronization. Your files are safe. Copy diagnostics if it happens again.',action:'retry',actionLabel:'Try again'}
   };
   if(problems[state])p.sync.update({problem:{code:'fixture',...problems[state]},retryAt:state==='offline'?Date.now()+40000:null});
   if(state==='paused')p.sync.update({paused:true});
   if(state==='progress')p.sync.update({fileProgress:{direction:'upload',path:longPath,transferredBytes:32768,totalBytes:8388608}});
   if(['first-sync','deletions','rebuild'].includes(state)) {
    const count=state==='deletions'?25:1;
    const command=state==='first-sync'?'put_remote':state==='deletions'?'delete_remote':'write_local';
    const action=command.startsWith('delete')?'delete':'create';
    const direction=command.endsWith('remote')?'upload':'download';
    const entries=Array.from({length:count},(_,i)=>({kind:'document',path:count>1?`Archive/Note ${i+1}.md`:longPath,direction,action,detail:action==='delete'?'Delete from Connect.':direction==='download'?'Download from Connect.':'Upload to Connect.'}));
    const actions=entries.map(entry=>({command,target:{path:entry.path}}));
    const kind=state==='first-sync'?'initial':state==='rebuild'?'rebuild':'incremental';
    p.sync.update({preview:{phase:kind,entries,plan:{kind,actions,issues:[],summary:{blocking_issues:0}},collisions:[],local_issues:[]}});
   }
   if(state==='conflict') {
    p.sync.update({status:{state:'attention',conflicts:[{entity:'record',object_id:'record',decision_id:'decision',path:longPath,message:'Both versions changed. Choose which version to sync.'}],local_issues:[]}});
    view.sync.conflictComparisons.set('record:decision',{entity:'record',objectId:'record',decisionId:'decision',local:{state:'exact',document:'Line from this device'},remote:{state:'exact',document:'Line from another device'}});
   }
   if(state==='history') {
    const at=new Date().toISOString();
    window.fixtureRuns=[{id:'fixture-conflict',collectionId:'ux-fixture',startedAt:at,finishedAt:at,outcome:'event',files:[],summary:'Kept both versions of '+longPath.split('/').pop(),message:"This device's version was saved as "+longPath.replace('.md',' (local conflict copy).md'),path:longPath,tone:'attention',needsAcknowledgement:true}];
   }
   if(['enrollment','upload'].includes(state)) {
    p.settings.mirrorProfile=null;
    if(state==='upload')view.schema={config:{spec_version:'0.3.0'},types:new Map(),contracts:new Map()};
   }
   view.render();
  },state);
  for(const width of [1100,390])for(const theme of ['theme-dark','theme-light']) {
   await page.setViewportSize({width,height:900});
   await page.evaluate(theme=>{document.body.classList.remove('theme-dark','theme-light');document.body.classList.add(theme)},theme);
   const checks=await page.locator('.mdbase-sync-document').evaluate(el=>{
    const content=el.closest('.mdbase-workspace-content');
    const buttons=[...el.querySelectorAll('.mod-cta, .mdbase-activity-row > button')].map(b=>({text:b.textContent,height:b.getBoundingClientRect().height}));
    return {paneWidth:content.clientWidth,scrollWidth:content.scrollWidth,overflow:content.scrollWidth>content.clientWidth+1,buttons};
   });
   const box=await page.locator('.mdbase-workspace').boundingBox();
   const cdp=await page.context().newCDPSession(page);
   const capture=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{...box,scale:1}});
   await cdp.detach();fs.writeFileSync(`${shots}/${prefix}-${state}-${width}-${theme}.png`,Buffer.from(capture.data,'base64'));
   const failures=[];
   if(checks.overflow)failures.push('Horizontal overflow');
   if(width===390&&checks.buttons.some(b=>b.height<43.5))failures.push('Primary/dismiss target below 44px');
   results.push({state,width,theme,...checks,failures});
   if(failures.length)console.log(JSON.stringify(results.at(-1)));
  }
 }
 fs.writeFileSync(`${shots}/${prefix}-checks.json`,JSON.stringify(results,null,2)+'\n');
 console.log(JSON.stringify({states:states.length,checks:results.length,failed:results.filter(r=>r.failures.length).length}));
 await browser.close();
 process.exitCode=results.some(r=>r.failures.length)?1:0;
})().catch(e=>{console.error(e);process.exit(1)});
