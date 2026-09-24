const API="https://en.wikipedia.org/w/api.php?origin=*&format=json&";
const DEFAULT_STUDY_SECONDS=60;
const RANKED_ELO_RANGE=300;
const AVERAGE_CLICKS=16;
const AVERAGE_RACE_SECONDS=130;
const BASE_ELO_CHANGE=20;
const ACCOUNT_KEY='linkrace_accounts';
const SESSION_KEY='linkrace_session';
const app=document.getElementById('app');
let currentUser=null;
let peer,conns=[],hostConn,isHost=false,name="",code="";
let state={phase:'home',start:null,target:null,phaseStart:0,studySeconds:DEFAULT_STUDY_SECONDS,ranked:false,rankedResult:null,players:{}};
let myPath=[],curArticle=null,timerInt=null;
let appliedRankedResultId=null;
const RANK_TIERS=[
  {name:'Tourist',minElo:0,maxElo:399,divisions:['Tourist 3','Tourist 2','Tourist 1']},
  {name:'Pagehopper',minElo:400,maxElo:799,divisions:['Pagehopper 3','Pagehopper 2','Pagehopper 1']},
  {name:'Navigator',minElo:800,maxElo:1199,divisions:['Navigator 3','Navigator 2','Navigator 1']},
  {name:'Pathfinder',minElo:1200,maxElo:1599,divisions:['Pathfinder 3','Pathfinder 2','Pathfinder 1']},
  {name:'Educated',minElo:1600,maxElo:1999,divisions:['Educated 3','Educated 2','Educated 1']},
  {name:'Scholar',minElo:2000,maxElo:2399,divisions:['Scholar 3','Scholar 2','Scholar 1']},
  {name:'Wikipedia Final Boss',minElo:2400,maxElo:null,divisions:['Wikipedia Final Boss']}
];
const myId=()=>peer.id;

function readAccounts(){
  return [];
}
function writeAccounts(){return undefined;}
function readSession(){
  try{return JSON.parse(localStorage.getItem(SESSION_KEY)||'null');}catch{return null}
}
function writeSession(user){localStorage.setItem(SESSION_KEY,JSON.stringify({id:user.id,username:user.username}));}
function clearSession(){localStorage.removeItem(SESSION_KEY);}
function getCurrentUser(){
  return currentUser;
}
function setCurrentUser(user){
  currentUser=user;
  name=user.username;
}
async function logoutCurrentUser(){
  await fetch('/api/logout',{method:'POST',credentials:'same-origin'});
  currentUser=null;
  name='';
  renderHome();
}
function clamp(value,min,max){return Math.min(Math.max(value,min),max);}
function currentPlayerStats(){
  const user=getCurrentUser();
  const elo=user?.stats?.elo||1000;
  return {rank:rankNameForElo(elo),elo};
}
function rankNameForElo(elo){
  const tier=RANK_TIERS.find(item=>elo>=item.minElo && (item.maxElo===null || elo<=item.maxElo)) || RANK_TIERS[0];
  if(tier.name==='Wikipedia Final Boss')return tier.name;
  const tierSpan=tier.maxElo-tier.minElo+1;
  const divisionSize=tierSpan/3;
  const divisionIndex=Math.min(2,Math.floor((elo-tier.minElo)/divisionSize));
  return tier.divisions[divisionIndex];
}
function persistRankedDelta(delta){
  return fetch('/api/me/elo',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({delta})});
}
function rankedDelta({won,clicks,seconds}){
  const clickPerformance=(AVERAGE_CLICKS-clicks)/AVERAGE_CLICKS;
  const timePerformance=(AVERAGE_RACE_SECONDS-seconds)/AVERAGE_RACE_SECONDS;
  const performance=clamp(1+(clickPerformance+timePerformance)*0.35,0.45,1.75);
  if(won)return Math.round(BASE_ELO_CHANGE*performance);
  const lossPerformance=clamp(1-(clickPerformance+timePerformance)*0.2,0.5,1.5);
  return -Math.round(BASE_ELO_CHANGE*lossPerformance);
}
function applyRankedResult(){
  if(!state.rankedResult||state.rankedResult.id===appliedRankedResultId)return;
  const delta=state.rankedResult.deltas[myId()];
  if(typeof delta==='number')persistRankedDelta(delta);
  appliedRankedResultId=state.rankedResult.id;
}
function uid(){
  if(window.crypto&&crypto.randomUUID){return crypto.randomUUID();}
  return 'acct-'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);
}
function normalizeUsername(value){
  return (value||'').trim().replace(/\s+/g,' ').slice(0,18);
}
async function createAccount({username,password}){
  const response=await fetch('/api/register',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'Could not create account.');
  return data.account;
}
async function loginAccount({username,password}){
  const response=await fetch('/api/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'Invalid username or password.');
  return data.account;
}

function renderTopBar(){
  return `<div class="topbar"><button id="homeBtn" class="home-btn" type="button">🏠 Home</button><h2>WikiRush</h2></div>`;
}

function clearStudyTimer(){
  if(timerInt){clearInterval(timerInt); timerInt=null;}
}

function resetToHome(){
  clearStudyTimer();
  if(peer){try{peer.destroy();}catch(e){} }
  peer=undefined; hostConn=undefined; conns=[]; isHost=false; name=""; code="";
  state={phase:'home',start:null,target:null,phaseStart:0,studySeconds:DEFAULT_STUDY_SECONDS,ranked:false,rankedResult:null,players:{}};
  myPath=[]; curArticle=null; renderHome();
}

async function resolveTitle(title){
  const r=await fetch(API+"action=query&redirects=1&titles="+encodeURIComponent(title));
  const d=await r.json();
  const page=Object.values(d.query.pages)[0];
  return (page && !page.missing) ? page.title : null;
}
async function fetchRandomTitle(){
  const r=await fetch(API+"action=query&list=random&rnnamespace=0&rnfilterredir=nonredirects&rnlimit=1");
  const d=await r.json();
  return d.query.random[0].title;
}
const NS_SKIP=/^(File|Category|Help|Wikipedia|Template|Special|Portal|Talk|User|Draft|Module|MediaWiki):/i;
async function fetchArticle(title){
  const r=await fetch(API+"action=parse&redirects=1&prop=text&disableeditsection=1&disabletoc=0&page="+encodeURIComponent(title));
  const d=await r.json();
  if(!d.parse) return {title,html:'<p><i>(article not found — go back and try another link)</i></p>'};
  return {title:d.parse.title,html:d.parse.text['*']};
}
function attachLinks(container){
  container.onclick=e=>{
    const a=e.target.closest('a'); if(!a)return;
    e.preventDefault();
    const href=a.getAttribute('href')||'';
    const m=href.match(/^\/wiki\/([^#?]+)/); if(!m)return;
    const title=decodeURIComponent(m[1]).replace(/_/g,' ');
    if(NS_SKIP.test(title))return;
    clickLink(title);
  };
}

function blockFindShortcuts(){
  window.addEventListener('keydown',event=>{
    const key=(event.key||'').toLowerCase();
    const isFindShortcut=(event.ctrlKey||event.metaKey) && (key==='f' || key==='g');
    if(isFindShortcut){
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

function renderAuthScreen(){
  app.innerHTML=`${renderTopBar()}<h1>🔐 Account access</h1><div class="sub">Create an account or log in to keep your ranked progress.</div>
  <div class="card">
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <button id="showLoginBtn" class="ghost" type="button">Log in</button>
      <button id="showRegisterBtn" class="ghost" type="button">Register</button>
    </div>
    <div id="authFormWrap"></div>
    <div class="err" id="authErr"></div>
  </div>
  <footer>Accounts are stored in your browser for this prototype. For real public play, this should move to a server-backed auth system.</footer>`;
  const renderForm=(mode)=>{
    const wrap=document.getElementById('authFormWrap');
    const isRegister=mode==='register';
    wrap.innerHTML=`<div class="card" style="margin:0;padding:16px;border-radius:12px">
      <input id="authUser" placeholder="${isRegister?'Choose username':'Username'}" maxlength="18">
      <input id="authPass" type="password" placeholder="Password" maxlength="32">
      <button id="authSubmitBtn" type="button">${isRegister?'Create account':'Log in'}</button>
    </div>`;
    document.getElementById('authSubmitBtn').onclick=async()=>{
      try{
        const username=document.getElementById('authUser').value;
        const password=document.getElementById('authPass').value;
        if(isRegister){
          const user=await createAccount({username,password});
          setCurrentUser(user);
          renderHome();
          return;
        }
        const user=await loginAccount({username,password});
        setCurrentUser(user);
        renderHome();
      }catch(err){
        document.getElementById('authErr').textContent=err.message;
      }
    };
  };
  const loginBtn=document.getElementById('showLoginBtn');
  const registerBtn=document.getElementById('showRegisterBtn');
  loginBtn.onclick=()=>{document.getElementById('authErr').textContent=''; renderForm('login');};
  registerBtn.onclick=()=>{document.getElementById('authErr').textContent=''; renderForm('register');};
  renderForm('login');
  const homeBtn=document.getElementById('homeBtn'); if(homeBtn)homeBtn.onclick=resetToHome;
}

function renderHome(){
  if(!getCurrentUser()) return renderAuthScreen();
  const currentUser=getCurrentUser();
  const adminControls=currentUser.role==='admin'?`<div class="card"><div class="sub" style="margin:0">Admin controls</div><button id="resetAllEloBtn" class="secondary">Reset everyone to 300 Elo</button><div style="display:flex;gap:8px"><input id="adminUsername" placeholder="Username" maxlength="18"><input id="adminElo" type="number" min="0" max="100000" placeholder="Elo"><button id="setEloBtn" class="ghost">Set Elo</button></div><div class="err" id="adminErr"></div></div>`:'';
  app.innerHTML=`${renderTopBar()}<h1>🔗 WikiRush — Wikipedia Racing</h1>
  <div class="sub">Welcome back, ${currentUser.username}. Your ranked account is ready.</div>
  <div class="card"><input id="nm" placeholder="Your name" maxlength="18" value="${currentUser.username}">
  <button id="hostBtn">Host a new race</button>
  <button id="rankedBtn" class="secondary">Ranked queue</button>
  <div style="display:flex;gap:8px"><input id="joinCode" placeholder="ROOM CODE" maxlength="6" style="text-transform:uppercase"><button id="joinBtn" class="ghost">Join</button></div>
  <div class="sub">Ranked matches pair players within ${RANKED_ELO_RANGE} Elo. Baseline: ${AVERAGE_CLICKS} clicks and ${AVERAGE_RACE_SECONDS}s.</div>
  <div class="err" id="homeErr"></div></div>
  <div class="card"><div class="sub" style="margin:0">Account</div><div class="player"><span>Username</span><span>${currentUser.username}</span></div><div class="player"><span>Rank</span><span>${rankNameForElo(currentUser.stats.elo || 300)}</span></div><div class="player"><span>Elo</span><span>${currentUser.stats.elo || 300}</span></div></div>
    <div class="card"><div class="sub" style="margin:0">Account</div><div class="player"><span>Username</span><span>${currentUser.username}</span></div><div class="player"><span>Rank</span><span>${rankNameForElo(currentUser.stats.elo || 300)}</span></div><div class="player"><span>Elo</span><span>${currentUser.stats.elo || 300}</span></div></div>${adminControls}
  <footer>Runs peer-to-peer in your browser (no server, no accounts). Must be served over http(s) — e.g. GitHub Pages, Netlify, or "python -m http.server" locally — plain double-clicking the file may block networking.</footer>`;
  document.getElementById('hostBtn').onclick=doHost;
  document.getElementById('rankedBtn').onclick=()=>doHost(true);
  document.getElementById('joinBtn').onclick=doJoin;
  if(currentUser.role==='admin'){
    document.getElementById('resetAllEloBtn').onclick=async()=>{
      const response=await fetch('/api/admin/reset-elo',{method:'POST',credentials:'same-origin'});
      const data=await response.json();
      if(!response.ok){document.getElementById('adminErr').textContent=data.error||'Reset failed.';return;}
      document.getElementById('adminErr').textContent=`Reset ${data.updated} accounts to 300 Elo.`;
    };
    document.getElementById('setEloBtn').onclick=async()=>{
      const username=document.getElementById('adminUsername').value.trim();
      const elo=Number(document.getElementById('adminElo').value);
      const response=await fetch('/api/admin/accounts/'+encodeURIComponent(username)+'/elo',{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({elo})});
      const data=await response.json();
      document.getElementById('adminErr').textContent=response.ok?`${data.account.username} is now ${data.account.stats.elo} Elo.`:(data.error||'Elo update failed.');
    };
  }
  const homeBtn=document.getElementById('homeBtn'); if(homeBtn)homeBtn.onclick=logoutCurrentUser;
}

function broadcast(){
  const msg={type:'state',state};
  conns.forEach(c=>c.open&&c.send(msg));
}
function setupConn(c){
  c.on('data',msg=>{
    if(isHost){
      if(msg.type==='join'){
        if(state.ranked && Math.abs((msg.elo||300)-currentPlayerStats().elo)>RANKED_ELO_RANGE){
          c.send({type:'rankedReject',message:`Ranked queue only accepts players within ${RANKED_ELO_RANGE} Elo.`});
          c.close();
          return;
        }
        state.players[c.peer]={name:msg.name,rank:msg.rank||1,elo:msg.elo||300,finished:false,finishMs:0,pathLen:1,cur:state.start,rerollVote:false}; broadcast(); render();
      }
      if(msg.type==='progress'){
        Object.assign(state.players[c.peer],msg.data);
        if(msg.data.finished && state.ranked)settleRankedRace(c.peer);
        broadcast();
        render();
      }
      if(msg.type==='rerollVote'){state.players[c.peer]=(state.players[c.peer]||{name:'Player'}); state.players[c.peer].rerollVote=!!msg.value; if(Object.values(state.players).length && Object.values(state.players).every(p=>p.rerollVote)){rerollTargetArticle();} else {broadcast(); render();}}
    } else {
      if(msg.type==='state'){state=msg.state; applyRankedResult(); render();}
      if(msg.type==='rankedReject'){document.getElementById('homeErr')&&(document.getElementById('homeErr').textContent=msg.message); resetToHome();}
    }
  });
  c.on('close',()=>{if(isHost){delete state.players[c.peer];broadcast();render();}});
}

async function doHost(ranked=false){
  name=document.getElementById('nm').value.trim()||'Host';
  const stats=currentPlayerStats();
  isHost=true;
  code=Array.from({length:4},()=>String.fromCharCode(65+Math.floor(Math.random()*26))).join('');
  peer=new Peer('linkrace-'+code);
  peer.on('open',async()=>{
    const [start,target]=await Promise.all([fetchRandomTitle(),fetchRandomTitle()]);
    state={phase:'lobby',start,target,phaseStart:0,studySeconds:DEFAULT_STUDY_SECONDS,ranked,rankedResult:null,players:{[myId()]:{name,rank:stats.rank,elo:stats.elo,finished:false,finishMs:0,pathLen:1,cur:start,rerollVote:false}}};
    render();
  });
  peer.on('connection',c=>{conns.push(c);setupConn(c);});
  peer.on('error',e=>{document.getElementById('homeErr')&&(document.getElementById('homeErr').textContent='Error: '+e.type+' — try again.')});
}
function doJoin(){
  name=document.getElementById('nm').value.trim()||'Player';
  const stats=currentPlayerStats();
  code=document.getElementById('joinCode').value.trim().toUpperCase();
  isHost=false;
  peer=new Peer();
  peer.on('open',()=>{
    hostConn=peer.connect('linkrace-'+code);
    hostConn.on('open',()=>hostConn.send({type:'join',name,rank:stats.rank,elo:stats.elo}));
    conns=[hostConn];
    setupConn(hostConn);
  });
  peer.on('error',e=>{document.getElementById('homeErr').textContent='Could not join — check the code.'});
}

function sendProgress(data){
  if(isHost){
    Object.assign(state.players[myId()],data);
    if(data.finished && state.ranked)settleRankedRace(myId());
    broadcast();
    applyRankedResult();
    render();
  }
  else hostConn.send({type:'progress',data});
}

function settleRankedRace(winnerId){
  if(!isHost||!state.ranked||state.rankedResult)return;
  const resultId=`${Date.now()}-${winnerId}`;
  const deltas={};
  Object.entries(state.players).forEach(([playerId,player])=>{
    const seconds=player.finished
      ? Math.max(player.finishMs/1000,1)
      : Math.max((Date.now()-state.phaseStart-(state.studySeconds||DEFAULT_STUDY_SECONDS)*1000)/1000,1);
    deltas[playerId]=rankedDelta({
      won:playerId===winnerId,
      clicks:Math.max((player.pathLen||1)-1,1),
      seconds
    });
  });
  state.rankedResult={id:resultId,deltas};
}

function render(){
  if(state.phase==='lobby')renderLobby();
  else if(state.phase==='study')renderStudy();
  else if(state.phase==='racing')renderRace();
}
function renderLobby(){
  const studySeconds=Number(state.studySeconds||DEFAULT_STUDY_SECONDS);
  const list=Object.values(state.players).map(p=>`<div class="player"><span>${p.name}</span><span>${p.rank||rankNameForElo(p.elo||300)} · ${p.elo||300} Elo</span></div>`).join('');
  app.innerHTML=`${renderTopBar()}<h1>${state.ranked?'Ranked queue':'Lobby'}</h1><div class="sub">${state.ranked?'Players must be within '+RANKED_ELO_RANGE+' Elo of the host.':'Share this code'}</div>
  <div class="card"><div class="code">${code}</div>${list}
  ${isHost?`<label class="sub" for="customStart">Start article (blank = random)</label>
  <input id="customStart" placeholder="e.g. Octopus" value="${state.start||''}">
  <label class="sub" for="customTarget">Target article (blank = random)</label>
  <input id="customTarget" placeholder="e.g. Bread">
  <label class="sub" for="studyDuration">Study time</label>
  <select id="studyDuration">${[15,30,45,60,90,120].map(s=>`<option value="${s}" ${s===studySeconds?'selected':''}>${s}s</option>`).join('')}</select>
  <button id="startBtn">Start race (${Object.keys(state.players).length} joined)</button>
  <div class="err" id="lobbyErr"></div>`:`<div class="sub">Study time: ${studySeconds}s — waiting for host…</div>`}</div>`;
  const homeBtn=document.getElementById('homeBtn'); if(homeBtn)homeBtn.onclick=resetToHome;
  if(isHost){
    document.getElementById('studyDuration').onchange=e=>{state.studySeconds=Number(e.target.value);broadcast();};
    document.getElementById('startBtn').onclick=async()=>{
      const errEl=document.getElementById('lobbyErr');
      const btn=document.getElementById('startBtn');
      const customStart=document.getElementById('customStart').value.trim();
      const customTarget=document.getElementById('customTarget').value.trim();
      btn.disabled=true; errEl.textContent='';
      let startTitle=state.start, targetTitle=state.target;
      if(customStart){
        const r=await resolveTitle(customStart);
        if(!r){errEl.textContent='Start article not found on Wikipedia.';btn.disabled=false;return;}
        startTitle=r;
      }
      if(customTarget){
        const r=await resolveTitle(customTarget);
        if(!r){errEl.textContent='Target article not found on Wikipedia.';btn.disabled=false;return;}
        targetTitle=r;
      }
      if(startTitle.toLowerCase()===targetTitle.toLowerCase()){errEl.textContent='Start and target must be different articles.';btn.disabled=false;return;}
      state.start=startTitle; state.target=targetTitle;
      Object.keys(state.players).forEach(id=>{if(state.players[id])state.players[id].rerollVote=false;});
      const chosen=Number(state.studySeconds||DEFAULT_STUDY_SECONDS);
      state.phase='study';state.phaseStart=Date.now();broadcast();render();
      clearStudyTimer();
      timerInt=setInterval(()=>{
        const left=chosen-Math.floor((Date.now()-state.phaseStart)/1000);
        const t=document.getElementById('studyTimer'); if(t)t.textContent=Math.max(left,0);
        if(left<=0){clearStudyTimer();state.phase='racing';broadcast();render();}
      },250);
    };
  }
}

async function rerollTargetArticle(){
  if(!isHost) return;
  clearStudyTimer();
  const [start,target]=await Promise.all([fetchRandomTitle(),fetchRandomTitle()]);
  state.start=start; state.target=target;
  while (start.toLowerCase()===target.toLowerCase()) {
    target = await fetchRandomTitle();
  }
  state.start=start; state.target=target;
  Object.keys(state.players).forEach(id=>{if(state.players[id])state.players[id].rerollVote=false;});
  state.phase='study'; state.phaseStart=Date.now();
  const chosen=Number(state.studySeconds||DEFAULT_STUDY_SECONDS);
  broadcast(); render();
  timerInt=setInterval(()=>{
    const left=chosen-Math.floor((Date.now()-state.phaseStart)/1000);
    const t=document.getElementById('studyTimer'); if(t)t.textContent=Math.max(left,0);
    if(left<=0){clearStudyTimer();state.phase='racing';broadcast();render();}
  },250);
}

function renderStudy(){
  const studySeconds=Number(state.studySeconds||DEFAULT_STUDY_SECONDS);
  const left=Math.max(studySeconds-Math.floor((Date.now()-state.phaseStart)/1000),0);
  const votes=Object.values(state.players).filter(p=>p.rerollVote).length;
  const total=Object.keys(state.players).length || 1;
  const myVote = (state.players[myId()]||{}).rerollVote === true;
  app.innerHTML=`${renderTopBar()}<h1>Study the target</h1>
  <div class="card article"><h2>Loading…</h2></div>
  <div class="timer" id="studyTimer">${left}</div>
  <div class="sub" style="text-align:center">Memorize this — links are disabled, and you won't see it again once the race starts.</div>
  <div class="card">
    <div class="sub">Vote to reroll</div>
    <div class="reroll-row">
      <button id="rerollBtn" class="${myVote?'secondary':'ghost'}" type="button">${myVote?'Voted to reroll':'Vote to reroll'}</button>
      <span class="vote-pill ${votes>=total&&total>0?'':'warn'}">${votes}/${total} players agreed</span>
    </div>
  </div>`;
  const homeBtn=document.getElementById('homeBtn'); if(homeBtn)homeBtn.onclick=resetToHome;
  document.getElementById('rerollBtn').onclick=()=>{
    const player=state.players[myId()]||{name};
    player.rerollVote = !player.rerollVote;
    state.players[myId()] = player;
    if(isHost){
      if(Object.values(state.players).length && Object.values(state.players).every(p=>p.rerollVote)){rerollTargetArticle();return;}
    } else {
      hostConn.send({type:'rerollVote',value:player.rerollVote});
    }
    broadcast();
    render();
  };
  const studyTargetBubble=`<div class="target-bubble"><span class="tag">Target</span>${state.target}</div>`;
  document.body.insertAdjacentHTML('beforeend', studyTargetBubble);
  window.scrollTo(0,0);
  fetchArticle(state.target).then(a=>{
    const el=app.querySelector('.article');
    if(el)el.innerHTML=`<h2>${a.title}</h2><div class="wp-body no-nav">${a.html}</div>`;
  });
  if(!isHost){
    clearStudyTimer();
    timerInt=setInterval(()=>{const t=document.getElementById('studyTimer');if(t){const l=Math.max(studySeconds-Math.floor((Date.now()-state.phaseStart)/1000),0);t.textContent=l;}},250);
  }
}
let lastRacedTitle=null;
function raceLeaderboardHtml(){
  const finishers=Object.values(state.players).filter(p=>p.finished).sort((a,b)=>a.finishMs-b.finishMs);
  return finishers.length?`<div class="card"><div class="winner">🏁 ${finishers[0].name} found it first!</div>${finishers.map((p,i)=>`<div class="player"><span>${i+1}. ${p.name}</span><span>${(p.finishMs/1000).toFixed(1)}s · ${p.pathLen} clicks</span></div>`).join('')}</div>`:'';
}
function updateRaceChrome(){
  const me=state.players[myId()]||{};
  const lb=document.getElementById('raceLeaderboard'); if(lb)lb.innerHTML=raceLeaderboardHtml();
  const trail=document.getElementById('raceTrail'); if(trail)trail.textContent='Path: '+myPath.join(' → ');
  const status=document.getElementById('raceStatus'); if(status)status.textContent=me.finished?'You made it! Waiting for others…':'Click any blue link in the text to go there.';
}
async function renderRace(){
  if(!myPath.length){myPath=[state.start];curArticle=await fetchArticle(state.start);}
  if(curArticle.title===lastRacedTitle){updateRaceChrome();return;}
  lastRacedTitle=curArticle.title;
  app.innerHTML=`${renderTopBar()}<h1>Race!</h1><div class="trail" id="raceTrail"></div>
  <div id="raceLeaderboard"></div>
  <div class="card article"><h2>${curArticle.title}</h2><div class="wp-body" id="raceBody">${curArticle.html}</div></div>
  <div class="sub" id="raceStatus"></div>`;
  const homeBtn=document.getElementById('homeBtn'); if(homeBtn)homeBtn.onclick=resetToHome;
  const targetBubble=document.querySelector('.target-bubble'); if(targetBubble)targetBubble.remove();
  const targetBubbleHtml=`<div class="target-bubble"><span class="tag">Target</span>${state.target}</div>`;
  document.body.insertAdjacentHTML('beforeend', targetBubbleHtml);
  attachLinks(document.getElementById('raceBody'));
  updateRaceChrome();
}
async function clickLink(title){
  if((state.players[myId()]||{}).finished)return;
  const a=await fetchArticle(title);
  myPath.push(a.title);
  curArticle=a;
  const norm=s=>s.toLowerCase().replace(/_/g,' ').trim();
  const won=norm(a.title)===norm(state.target);
  const studySeconds=Number(state.studySeconds||DEFAULT_STUDY_SECONDS);
  sendProgress({cur:a.title,pathLen:myPath.length,finished:won,finishMs:won?(Date.now()-state.phaseStart)-studySeconds*1000:0});
}
async function bootstrapAuth(){
  try{
    const response=await fetch('/api/me',{credentials:'same-origin'});
    if(response.ok){
      const data=await response.json();
      setCurrentUser(data.account);
    }
  }catch(error){
    console.warn('Account server unavailable.',error);
  }
  renderHome();
}
blockFindShortcuts();
bootstrapAuth();
