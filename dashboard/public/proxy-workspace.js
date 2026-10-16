(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GladosProxyWorkspace = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const sessions = new Map();
  let mounted = null;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const interceptFields = ['interceptRequests','interceptResponses','interceptWebsocketClient','interceptWebsocketServer'];
  const interceptEnabled = state => interceptFields.some(key => state?.[key] === true);
  const interceptSettings = (current, changes = {}) => ({...Object.fromEntries(interceptFields.map(key => [key, current?.[key] === true])), ...changes});
  const tabs = [['intercept','Intercept'],['http','HTTP history'],['websockets','WebSockets history'],['settings','Proxy settings']];
  function apiUrl(path, sessionId, params = {}) {
    if (!sessionId) throw new Error('Choose a session before opening its proxy.');
    const query = new URLSearchParams({session_id:sessionId});
    for (const [key,value] of Object.entries(params)) if (key !== 'session_id' && value !== undefined && value !== null && value !== '') query.set(key,String(value));
    return `/api/proxy/${path}?${query}`;
  }
  function sessionState(sessionId) {
    if (!sessionId) throw new Error('Session ID required');
    if (!sessions.has(sessionId)) sessions.set(sessionId, {sessionId,tab:'intercept',rows:[],websockets:[],pending:[],selected:null,selectedIds:new Set(),anchor:null,details:new Map(),maxRows:5000,browsingOlder:false,filter:'',status:'',method:'',hideStatic:false,sort:'id',descending:false,requestMode:'pretty',responseMode:'pretty',wsMode:'pretty',detailHeight:300,annotations:{},focus:null,loaded:false});
    return sessions.get(sessionId);
  }
  function matches(row, state) {
    if (state.filter && ![row.url,row.method,row.host,row.mime,row.agentTag].join(' ').toLowerCase().includes(state.filter.toLowerCase())) return false;
    if (state.method && row.method !== state.method) return false;
    if (state.status && Math.floor(Number(row.status)/100) !== Number(state.status)) return false;
    if (state.hideStatic && /\.(?:css|js|png|jpe?g|gif|svg|ico|woff2?|ttf)(?:[?#]|$)/i.test(row.url)) return false;
    return true;
  }
  function urlParts(url) { try { const u=new URL(url);return {host:u.host,path:u.pathname+u.search,tls:['https:','wss:'].includes(u.protocol),params:!!u.search,extension:u.pathname.match(/\.([a-z0-9]{1,10})$/i)?.[1]||''}; } catch { return {host:'',path:url||'',tls:false,params:false,extension:''}; } }
  function rawMessage(detail, row, response = false) {
    if (!detail) return '';
    const line = response ? detail.statusLine || `HTTP/1.1 ${row.status||''}` : detail.requestLine || `${row.method||'GET'} ${urlParts(row.url).path} HTTP/1.1`;
    const headers = detail[response?'responseHeaders':'requestHeaders'] || {};
    const body = detail[response?'responseBody':'requestBody'] || '';
    const truncated=detail[response?'responseBodyTruncated':'requestBodyTruncated'];
    return `${line}\r\n${Object.entries(headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n${body}${truncated?'\n[Captured body truncated]':''}`;
  }
  function pretty(raw) {
    const split=raw.search(/\r?\n\r?\n/);if(split<0)return raw;
    const head=raw.slice(0,split),body=raw.slice(split).replace(/^\r?\n\r?\n/,'');
    try{return `${head}\n\n${JSON.stringify(JSON.parse(body),null,2)}`;}catch{return raw;}
  }
  function hex(raw, base64 = false) {
    const bytes=base64?Uint8Array.from(atob(raw),c=>c.charCodeAt(0)):new TextEncoder().encode(raw);const rows=[];
    for(let i=0;i<bytes.length;i+=16){const part=bytes.slice(i,i+16);rows.push(`${i.toString(16).padStart(8,'0')}  ${[...part].map(b=>b.toString(16).padStart(2,'0')).join(' ').padEnd(47)}  ${[...part].map(b=>b>=32&&b<127?String.fromCharCode(b):'.').join('')}`);}
    return rows.join('\n');
  }
  function mergeRows(current, incoming, sessionId) {
    const map=new Map(current.filter(row=>row.sessionId===sessionId).map(row=>[String(row.id),row]));
    for(const row of incoming||[]) if(row.sessionId===sessionId) map.set(String(row.id),previewRow(row));
    return [...map.values()].sort((a,b)=>Number(a.ts)-Number(b.ts)||String(a.id).localeCompare(String(b.id),undefined,{numeric:true}));
  }
  function previewRow(row) {
    if(row.type!=='websocket'||typeof row.body!=='string'||row.body.length<=2048)return row;
    return {...row,body:row.body.slice(0,2048),previewTruncated:true};
  }
  function dispose() { if(mounted){mounted.dispose();mounted=null;} }
  function clear() {dispose();sessions.clear();}
  function focus(sessionId,value) {const s=sessionState(sessionId);s.focus=value;s.tab='http';s.filter=value.host||'';}
  function mount(host, {sessionId,sessionName=sessionId,archived=false,onAgent,onSession,onError=()=>{}} = {}) {
    dispose();
    const state=sessionState(sessionId),abort=new AbortController();let es=null,timer=null,busy=false,dead=false,selectionVersion=0;const modals=new Set();
    const annotationKey=`glados-dash.proxy.annotations.${sessionId}`;
    try{state.annotations=JSON.parse(localStorage.getItem(annotationKey)||'{}');}catch{}
    const q=selector=>host.querySelector(selector);
    const active=()=>!dead&&host.isConnected;
    const endpoint=(path,params)=>apiUrl(path,sessionId,params);
    async function request(path,{method='GET',body,params}={}) {
      const r=await fetch(endpoint(path,params),{method,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(path==='browser/open'?45000:20000)]),headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify({...body,session_id:sessionId}):undefined});
      const data=await r.json();if(!r.ok||data.ok===false)throw new Error(data.error||`Proxy request failed (${r.status})`);return data;
    }
    function report(error) {if(!active()||error.name==='AbortError')return;q('[data-proxy-message]').textContent=error.message;onError(error);}
    host.className='proxy-workbench';
    host.innerHTML=`<header class="bp-session"><strong>Proxy</strong><button type="button" data-proxy-session title="Open this investigation session">${esc(sessionName)}</button><code data-proxy-address>Listener not started</code><span data-proxy-health>Checking listener…</span><label class="bp-browser-agent">Agent browser<select data-proxy-browser-agent aria-label="Assessment browser agent" disabled><option>Loading agents…</option></select></label><button type="button" data-proxy-browser disabled>Open browser</button><button type="button" data-proxy-setup>Browser setup</button></header><nav class="bp-tabs" role="tablist" aria-label="Proxy views">${tabs.map(([id,label])=>`<button type="button" role="tab" data-proxy-tab="${id}" aria-selected="${state.tab===id}">${label}</button>`).join('')}</nav><div class="bp-message" role="status" data-proxy-message></div><div class="bp-workspace" data-proxy-workspace></div>`;
    q('[data-proxy-session]').onclick=()=>Promise.resolve(onSession?.(sessionId)).catch(report);
    q('[data-proxy-browser-agent]').onchange=e=>{state.browserAgentId=e.target.value;};
    q('[data-proxy-browser]').onclick=async e=>{
      e.currentTarget.disabled=true;
      try{
        const agentId=state.browserAgentId;
        if(!agentId)throw new Error('Choose a browser-enabled agent for this session.');
        q('[data-proxy-message]').textContent='Opening this agent’s Playwright assessment browser…';
        const result=window.gladosDesktop?.openProxyBrowser
          ?await window.gladosDesktop.openProxyBrowser({sessionId,agentId})
          :await request('browser/open',{method:'POST',body:{agent_id:agentId}});
        if(!active())return;
        if(result.sessionId!==sessionId||result.agentId!==agentId)throw new Error('The assessment browser belongs to another session or agent.');
        q('[data-proxy-message]').textContent='Playwright MCP controls this same browser, including its tabs and login state. Traffic is captured in this session.';
        state.meta=await request('session');updateMeta();
      }catch(error){report(error);}finally{if(active())q('[data-proxy-browser]').disabled=archived||!state.browserAgentId;}
    };
    async function loadBrowserAgents(){
      const inventory=await request('browsers');if(!active())return;
      if(inventory.sessionId!==sessionId)throw new Error('Wrong browser inventory session.');
      const agents=inventory.agents||[],select=q('[data-proxy-browser-agent]');
      state.browserAgentId=agents.some(row=>row.id===state.browserAgentId)?state.browserAgentId:inventory.defaultAgentId;
      select.innerHTML=agents.length?agents.map(row=>`<option value="${esc(row.id)}">${esc(row.name)}${row.running?' · open':''}</option>`).join(''):'<option value="">No browser-enabled agent</option>';
      select.value=state.browserAgentId||'';select.disabled=archived||!agents.length;
      q('[data-proxy-browser]').disabled=archived||!agents.length;
      q('[data-proxy-browser]').title=inventory.reason||'Open the same browser this agent uses through Playwright MCP';
      if(inventory.reason)q('[data-proxy-message]').textContent=inventory.reason;
    }
    q('[data-proxy-setup]').onclick=()=>{state.tab='settings';render();};
    host.querySelectorAll('[data-proxy-tab]').forEach(button=>button.onclick=()=>{state.tab=button.dataset.proxyTab;state.selected=null;state.selectedIds.clear();selectionVersion++;render();});
    function annotate(id,changes) {state.annotations[id]={...state.annotations[id],...changes};try{localStorage.setItem(annotationKey,JSON.stringify(state.annotations));}catch{}paintRows();}
    function tableRows() {
      let rows=state.tab==='websockets'?state.websockets:state.tab==='intercept'?state.pending:state.rows;
      rows=rows.filter(row=>matches(row,state));
      const key=state.sort;return rows.slice().sort((a,b)=>{let x=key==='host'?urlParts(a.url).host:a[key],y=key==='host'?urlParts(b.url).host:b[key];return(typeof x==='number'&&typeof y==='number'?x-y:String(x??'').localeCompare(String(y??''),undefined,{numeric:true}))*(state.descending?-1:1);});
    }
    function columns() {
      if(state.tab==='websockets')return [['id','#'],['url','URL'],['fromClient','Direction'],['bodyLen','Length'],['binary','Type'],['edited','Edited'],['ts','Time'],['agentTag','Agent'],['notes','Notes']];
      if(state.tab==='intercept')return [['id','#'],['host','Host'],['method','Method'],['url','URL'],['phase','Type'],['status','Status'],['createdAt','Received'],['notes','Notes']];
      return [['id','#'],['host','Host'],['method','Method'],['url','URL'],['params','Params'],['edited','Edited'],['status','Status'],['respLen','Length'],['mime','MIME type'],['extension','Extension'],['tls','TLS'],['ts','Time'],['agentTag','Agent'],['notes','Notes']];
    }
    function cell(row,key) {
      const u=urlParts(row.url);
      if(key==='id'){const source=state.tab==='websockets'?state.websockets:state.tab==='intercept'?state.pending:state.rows;return source.findIndex(item=>String(item.id)===String(row.id))+1;}
      if(key==='url')return state.tab==='websockets'?row.url:u.path;
      if(key==='host')return u.host;if(key==='params')return u.params?'✓':'';if(key==='extension')return u.extension;if(key==='tls')return u.tls?'✓':'';
      if(key==='ts'||key==='createdAt')return new Date(row[key]).toLocaleTimeString();
      if(key==='fromClient')return row.fromClient?'→ Server':'← Client';if(key==='binary')return row.binary?'Binary':'Text';
      if(key==='edited')return row.edited?'✓':'';
      if(key==='notes')return state.annotations[row.id]?.notes||'';return row[key]??'';
    }
    function render() {
      if(!active())return;
      host.querySelectorAll('[data-proxy-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.proxyTab===state.tab)));
      if(state.tab==='settings'){renderSettings();return;}
      const intercepted=state.tab==='intercept',ws=state.tab==='websockets';
      q('[data-proxy-workspace]').innerHTML=`${intercepted?`<div class="bp-intercept-controls"><button type="button" data-forward disabled>Forward</button><button type="button" data-drop disabled>Drop</button><button type="button" data-intercept-toggle${archived?' disabled':''}>Intercept is ${interceptEnabled(state.intercept)?'on':'off'}</button><button type="button" data-forward-all disabled>Forward all</button><button type="button" data-drop-all disabled>Drop all</button><span data-pending-count></span></div>`:''}<div class="bp-filter-bar"><button type="button" data-filter-toggle aria-expanded="false">Filter settings ▾</button><span data-filter-description>Showing all items</span><input type="search" data-filter placeholder="Search ${ws?'WebSocket messages':'HTTP history'}" aria-label="Search proxy history" value="${esc(state.filter)}"><button type="button" data-export>Export…</button><button type="button" data-refresh title="Refresh this session’s traffic">↻</button></div><div class="bp-filters" data-filters hidden><label>Method <select data-method><option value="">All</option>${['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','CONNECT'].map(m=>`<option${state.method===m?' selected':''}>${m}</option>`).join('')}</select></label><label>Status <select data-status><option value="">All</option>${[2,3,4,5].map(n=>`<option value="${n}"${state.status===String(n)?' selected':''}>${n}xx</option>`).join('')}</select></label><label><input type="checkbox" data-hide-static${state.hideStatic?' checked':''}>Hide images, CSS and scripts</label><button type="button" data-reset-filter>Reset</button></div><div class="bp-table-wrap"><table class="bp-history"><thead><tr>${columns().map(([key,label])=>`<th scope="col"><button type="button" data-sort="${key}">${label}<span>${state.sort===key?(state.descending?' ▾':' ▴'):''}</span></button></th>`).join('')}</tr></thead><tbody data-proxy-rows></tbody></table></div><div class="bp-history-footer"><span data-row-count></span>${!intercepted?'<button type="button" data-load-older>Load older</button><button type="button" data-load-latest>Latest</button>':''}<span class="bp-capture-note" title="Stored history redacts credentials and may truncate bodies. Live intercepted messages can be edited before forwarding.">Retained capture · credentials redacted</span></div><div class="bp-divider" role="separator" aria-label="Resize message editors" aria-orientation="horizontal" tabindex="0"></div><div class="bp-inspection" style="height:${state.detailHeight}px"><div class="bp-editors"><section class="bp-editor" data-request-editor></section>${ws?'':'<section class="bp-editor" data-response-editor></section>'}</div><aside class="bp-inspector"><h3>Inspector</h3><div data-inspector-content><p>Select a message to inspect it.</p></div></aside></div>`;
      const bind=(selector,event,fn)=>q(selector)?.addEventListener(event,fn);
      bind('[data-filter-toggle]','click',e=>{const panel=q('[data-filters]');panel.hidden=!panel.hidden;e.currentTarget.setAttribute('aria-expanded',String(!panel.hidden));});
      bind('[data-filter]','input',e=>{state.filter=e.target.value;paintRows();});
      bind('[data-method]','change',e=>{state.method=e.target.value;paintRows();});
      bind('[data-status]','change',e=>{state.status=e.target.value;paintRows();});
      bind('[data-hide-static]','change',e=>{state.hideStatic=e.target.checked;paintRows();});
      bind('[data-reset-filter]','click',()=>{state.filter='';state.method='';state.status='';state.hideStatic=false;render();});
      bind('[data-refresh]','click',()=>refresh(true).catch(report));
      bind('[data-load-older]','click',()=>loadOlder().catch(report));
      bind('[data-load-latest]','click',()=>{state.browsingOlder=false;state.rows=[];state.websockets=[];refresh(true).catch(report);});
      bind('[data-export]','click',exportMenu);
      bind('[data-intercept-toggle]','click',async e=>{e.currentTarget.disabled=true;try{state.intercept=await request('intercept',{method:'POST',body:interceptEnabled(state.intercept)?Object.fromEntries(interceptFields.map(key=>[key,false])):interceptSettings(state.intercept,{interceptRequests:true})});if(active()&&state.tab==='intercept')render();}catch(error){report(error);if(active())e.currentTarget.disabled=false;}});
      bind('[data-forward]','click',()=>act('forward',false).catch(report));bind('[data-drop]','click',()=>act('drop',false).catch(report));
      bind('[data-forward-all]','click',()=>act('forward',true).catch(report));bind('[data-drop-all]','click',()=>act('drop',true).catch(report));
      host.querySelectorAll('[data-sort]').forEach(b=>b.onclick=()=>{state.descending=state.sort===b.dataset.sort?!state.descending:false;state.sort=b.dataset.sort;paintRows();});
      const divider=q('.bp-divider');divider.onpointerdown=e=>{divider.setPointerCapture(e.pointerId);const start=e.clientY,height=state.detailHeight;divider.onpointermove=move=>{state.detailHeight=Math.max(160,Math.min(host.clientHeight-210,height+start-move.clientY));q('.bp-inspection').style.height=`${state.detailHeight}px`;};divider.onpointerup=()=>{divider.onpointermove=null;};};
      divider.onkeydown=e=>{if(!['ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();state.detailHeight=Math.max(160,Math.min(host.clientHeight-210,state.detailHeight+(e.key==='ArrowUp'?25:-25)));q('.bp-inspection').style.height=`${state.detailHeight}px`;};
      paintRows();renderEmptyEditors();
      if(state.selected){const row=tableRows().find(r=>String(r.id)===String(state.selected));if(row)selectRow(row,false);}
    }
    function paintRows() {
      const tbody=q('[data-proxy-rows]');if(!tbody)return;
      const rows=tableRows();
      host.querySelectorAll('[data-sort]').forEach(button=>{button.querySelector('span').textContent=state.sort===button.dataset.sort?(state.descending?' ▾':' ▴'):'';button.closest('th').setAttribute('aria-sort',state.sort===button.dataset.sort?(state.descending?'descending':'ascending'):'none');});
      tbody.innerHTML=rows.length?rows.map(row=>`<tr tabindex="0" data-flow-id="${esc(row.id)}" aria-selected="${String(row.id)===String(state.selected)}"${state.annotations[row.id]?.color?` data-highlight="${esc(state.annotations[row.id].color)}"`:''}>${columns().map(([key])=>`<td class="bp-col-${key}" title="${esc(cell(row,key))}">${esc(cell(row,key))}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="${columns().length}" class="bp-empty"><strong>${state.tab==='intercept'?(interceptEnabled(state.intercept)?'Waiting for an intercepted message':'Intercept is off'):state.tab==='websockets'?'No WebSocket messages in this session':'No HTTP messages in this session'}</strong><span>${state.tab==='intercept'?'Traffic continues to appear in HTTP history while interception is off.':'Use this session’s listener to capture traffic here.'}</span></td></tr>`;
      tbody.querySelectorAll('[data-flow-id]').forEach(tr=>{
        const row=rows.find(r=>String(r.id)===tr.dataset.flowId);
        tr.onclick=e=>{if(e.shiftKey&&state.anchor){const a=rows.findIndex(r=>String(r.id)===String(state.anchor)),b=rows.indexOf(row);if(a>=0)for(let i=Math.min(a,b);i<=Math.max(a,b);i++)state.selectedIds.add(String(rows[i].id));}else if(e.metaKey||e.ctrlKey){const id=String(row.id);if(state.selectedIds.has(id))state.selectedIds.delete(id);else state.selectedIds.add(id);}else state.selectedIds=new Set([String(row.id)]);state.anchor=row.id;selectRow(row);};
        tr.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();tr.click();}};
        tr.oncontextmenu=e=>{e.preventDefault();selectRow(row);openActions(row,e.clientX,e.clientY);};
        tr.classList.toggle('bp-multi-selected',state.selectedIds.has(String(row.id)));
      });
      q('[data-row-count]').textContent=`${rows.length} / ${(state.tab==='http'?state.rows:state.tab==='websockets'?state.websockets:state.pending).length} items${state.selectedIds.size?` · ${state.selectedIds.size} selected`:''}`;
      q('[data-filter-description]').textContent=state.filter||state.status||state.method||state.hideStatic?'Filter active':'Showing all items';
      if(q('[data-pending-count]'))q('[data-pending-count]').textContent=`${state.pending.length} intercepted`;
      for(const selector of ['[data-forward-all]','[data-drop-all]'])if(q(selector))q(selector).disabled=archived||state.pending.length===0;
    }
    function renderEmptyEditors(){editor(q('[data-request-editor]'),state.tab==='websockets'?'Message':'Request','',state.tab==='websockets'?'ws':'request');if(q('[data-response-editor]'))editor(q('[data-response-editor]'),'Response','','response');}
    function editor(container,label,raw,type,{editable=false,body='',binary=false}={}) {
      if(!container)return;const key=`${type}Mode`,mode=editable?'raw':state[key]||'pretty';container.innerHTML=`<header class="bp-editor-title"><strong>${label}</strong><span data-editor-meta></span><button type="button" data-copy-message title="Copy ${label.toLowerCase()}">Copy</button>${type==='request'&&state.tab==='http'?'<button type="button" data-replay>Replay…</button>':''}</header><div class="bp-message-tabs" role="tablist" aria-label="${label} format">${(editable?['raw']:['pretty','raw','hex',...(type==='response'&&body?['render']:[])]).map(m=>`<button type="button" role="tab" data-format="${m}" aria-selected="${mode===m}">${m[0].toUpperCase()+m.slice(1)}</button>`).join('')}</div><div class="bp-editor-content"></div><footer class="bp-editor-search"><input type="search" placeholder="Search" aria-label="Search ${label.toLowerCase()}"><span data-search-count></span><span>${editable?'Live message · editable':raw?'Captured message · read only':''}</span></footer>`;
      const content=container.querySelector('.bp-editor-content');
      if(editable){content.innerHTML='<textarea aria-label="Edit intercepted message" spellcheck="false"></textarea>';content.firstElementChild.value=raw;}
      else if(mode==='render'&&body){const frame=document.createElement('iframe');frame.setAttribute('sandbox','');frame.setAttribute('referrerpolicy','no-referrer');frame.title='Static response preview';const sanitized=typeof DOMPurify!=='undefined'?DOMPurify.sanitize(body,{FORBID_TAGS:['script','form','iframe','object','embed','base','link','meta']}):esc(body);frame.srcdoc=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><body>${sanitized}</body>`;content.appendChild(frame);}
      else {const pre=document.createElement('pre');pre.textContent=raw?(mode==='hex'?hex(raw,binary):mode==='pretty'?pretty(raw):raw):'Select a message to view its contents.';content.appendChild(pre);}
      container.querySelectorAll('[data-format]').forEach(b=>b.onclick=()=>{state[key]=b.dataset.format;editor(container,label,raw,type,{editable,body,binary});});
      container.querySelector('[data-copy-message]').onclick=()=>copy(editable?content.querySelector('textarea').value:raw);
      if(container.querySelector('[data-replay]'))container.querySelector('[data-replay]').disabled=archived;
      container.querySelector('[data-replay]')?.addEventListener('click',()=>replay(tableRows().find(r=>String(r.id)===String(state.selected))));
      container.querySelector('input[type="search"]').oninput=e=>{const text=e.target.value.toLowerCase(),source=(content.textContent||'').toLowerCase();container.querySelector('[data-search-count]').textContent=text?`${source.split(text).length-1} matches`:'';};
    }
    async function selectRow(row,repaint=true) {
      state.selected=row.id;const version=++selectionVersion,tab=state.tab;if(repaint)paintRows();
      if(tab==='intercept'){
        const editable=row.editable===true&&!archived;
        editor(q('[data-request-editor]'),row.phase==='websocket'?(row.fromClient?'WebSocket → Server':'WebSocket ← Client'):row.phase==='response'?'Intercepted response':'Intercepted request',row.raw||'', 'request',{editable,binary:row.binary===true});
        editor(q('[data-response-editor]'),'Response','','response');
        if(q('[data-forward]'))q('[data-forward]').disabled=archived;if(q('[data-drop]'))q('[data-drop]').disabled=archived;
        inspect(row,{});return;
      }
      if(tab==='websockets') {
        try {
          const key=`ws:${row.id}`;
          let detail=state.details.get(key);
          if(!detail) {
            detail=await request('websocket-detail',{params:{id:row.id}});
            if(!active()||version!==selectionVersion||state.tab!==tab)return;
            if(detail.sessionId!==sessionId)throw new Error('The message does not belong to this session.');
            const wsKeys=[...state.details.keys()].filter(k=>k.startsWith('ws:'));
            if(wsKeys.length>=20)state.details.delete(wsKeys[0]);
            state.details.set(key,detail);
          }
          editor(q('[data-request-editor]'),detail.fromClient?'Message → Server':'Message ← Client',detail.body||'','ws',{binary:detail.binary===true});
          inspect(detail,{});
        } catch(error) { report(error); }
        return;
      }
      renderEmptyEditors();
      try{let detail=state.details.get(String(row.id));if(!detail){detail=await request('detail',{params:{id:row.id}});if(!active()||version!==selectionVersion||state.tab!==tab)return;if(detail.sessionId!==sessionId)throw new Error('The message does not belong to this session.');if(state.details.size>=250)state.details.delete(state.details.keys().next().value);state.details.set(String(row.id),detail);}if(!active()||version!==selectionVersion)return;editor(q('[data-request-editor]'),'Request',rawMessage(detail,row),'request');editor(q('[data-response-editor]'),'Response',rawMessage(detail,row,true),'response',{body:detail.responseBody||''});inspect(row,detail);}catch(error){report(error);}
    }
    function inspect(row,detail) {
      const target=q('[data-inspector-content]');if(!target)return;
      let params=[];try{params=[...new URL(row.url).searchParams];}catch{}
      const list=entries=>`<dl>${entries.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
      target.innerHTML=`<details open><summary>Request attributes</summary>${list([['Session',sessionName],['URL',row.url],['Method',row.method||'WebSocket'],['Status',row.status||'—'],['Agent',row.agentTag||'Browser'],['Listener',state.meta?.listenPort||'—']])}</details>${[['Request query parameters',params],['Request headers',Object.entries(detail.requestHeaders||{})],['Response headers',Object.entries(detail.responseHeaders||{})]].map(([label,entries])=>`<details><summary>${label} <span>${entries.length}</span></summary>${list(entries)}</details>`).join('')}<details open><summary>Notes</summary><textarea data-message-notes aria-label="Message notes" placeholder="Add a note…">${esc(state.annotations[row.id]?.notes||'')}</textarea><label>Highlight <select data-message-highlight aria-label="Message highlight">${['','red','orange','yellow','green','blue','purple'].map(c=>`<option value="${c}"${state.annotations[row.id]?.color===c?' selected':''}>${c||'None'}</option>`).join('')}</select></label><small>Saved on this computer for this session.</small></details>`;
      target.querySelector('[data-message-notes]').onchange=e=>annotate(row.id,{notes:e.target.value.slice(0,4000)});target.querySelector('[data-message-highlight]').onchange=e=>annotate(row.id,{color:e.target.value});
    }
    async function act(action,all) {
      const ids=all?state.pending.map(r=>r.id):state.selectedIds.size?[...state.selectedIds]:[state.selected];
      const textarea=q('[data-request-editor] textarea');const selected=state.pending.find(r=>String(r.id)===String(state.selected));
      for(const id of ids.filter(Boolean)){await request(`intercept/${encodeURIComponent(id)}`,{method:'POST',body:{action,...(!all&&String(id)===String(state.selected)&&selected?.editable&&textarea&&textarea.value!==selected.raw?{raw:textarea.value}:{})}});}
      if(active()){state.selected=null;state.selectedIds.clear();await refresh();if(state.tab==='intercept')render();}
    }
    function renderSettings() {
      const m=state.meta||{},running=m.health?.healthy===true;
      q('[data-proxy-workspace]').innerHTML=`<div class="bp-settings"><section><h2>Proxy listeners</h2><p>This listener belongs to <strong>${esc(sessionName)}</strong>. Browser traffic and agent traffic stay in this session.</p><table class="bp-listeners"><thead><tr><th>Running</th><th>Interface</th><th>Port</th><th>Session</th></tr></thead><tbody><tr><td>${running?'✓ Running':'Stopped'}</td><td>${esc(m.listenHost||'127.0.0.1')}</td><td>${esc(m.listenPort||'Assigned when started')}</td><td>${esc(sessionName)}</td></tr></tbody></table><div class="bp-setting-actions"><button type="button" data-start-listener${archived?' disabled':''}>${running?'Check listener':'Start listener'}</button><button type="button" data-copy-address${m.proxyUrl?'':' disabled'}>Copy proxy URL</button><a class="bp-button" href="${esc(endpoint('ca'))}" download="glados-proxy-ca.pem">Export CA certificate</a></div></section><section><h2>Request interception</h2><label><input type="checkbox" data-setting-requests${state.intercept?.interceptRequests?' checked':''}${archived?' disabled':''}>Intercept requests before they reach the server</label></section><section><h2>Response interception</h2><label><input type="checkbox" data-setting-responses${state.intercept?.interceptResponses?' checked':''}${archived?' disabled':''}>Intercept responses before they reach the client</label><p>Turning interception off forwards held messages unchanged. Use Drop in Intercept to cancel them.</p></section><section><h2>WebSocket interception</h2><label><input type="checkbox" data-setting-ws-client${state.intercept?.interceptWebsocketClient?' checked':''}${archived?' disabled':''}>Intercept client-to-server messages</label><label><input type="checkbox" data-setting-ws-server${state.intercept?.interceptWebsocketServer?' checked':''}${archived?' disabled':''}>Intercept server-to-client messages</label><p>Text messages can be edited before forwarding. Binary messages can be inspected, forwarded unchanged, or dropped.</p></section><section><h2>Assessment browser</h2><p>Choose an agent above, then Open browser. This opens the real Playwright browser that the selected agent controls through Browser MCP, with the same tabs and login state. Each agent and investigation has its own profile.</p><p>GLaDOS routes this browser through the session listener and trusts the exact local proxy CA. The proxy still verifies upstream HTTPS certificates.</p><details><summary>Configure another test browser</summary><p>Set its HTTP and HTTPS proxy to <code>${esc(m.listenHost||'127.0.0.1')}:${esc(m.listenPort||'—')}</code> and import the exported public CA certificate into that browser’s certificate store.</p></details></section><section><h2>History capture</h2><p>HTTP and WebSocket history continues while Intercept is off. Retained history redacts credentials and may truncate large bodies; it does not contain the original secret values.</p><p>Live intercepted message previews are temporary. Unhandled messages expire after five minutes.</p></section></div>`;
      q('[data-start-listener]').onclick=async()=>{try{state.meta=await request('session',{method:'POST',body:{}});updateMeta();renderSettings();}catch(error){report(error);}};
      q('[data-copy-address]').onclick=()=>copy(m.proxyUrl);
      for(const key of ['requests','responses','ws-client','ws-server'])q(`[data-setting-${key}]`).onchange=async()=>{try{state.intercept=await request('intercept',{method:'POST',body:{interceptRequests:q('[data-setting-requests]').checked,interceptResponses:q('[data-setting-responses]').checked,interceptWebsocketClient:q('[data-setting-ws-client]').checked,interceptWebsocketServer:q('[data-setting-ws-server]').checked}});}catch(error){report(error);renderSettings();}};
    }
    function updateMeta(){if(!active())return;const m=state.meta||{};q('[data-proxy-address]').textContent=m.proxyUrl||'Listener not started';q('[data-proxy-health]').textContent=archived?'Archived session · read only':m.health?.healthy?'● Listening':'○ Listener stopped';q('[data-proxy-health]').dataset.healthy=String(m.health?.healthy===true);}
    async function refresh(force=false) {
      if(busy||!active())return;busy=true;
      try{
        const newest=rows=>rows.length?rows[rows.length-1].id:undefined;
        const [intercept,history,ws]=await Promise.all([request('intercept'),state.browsingOlder?[]:request('history',{params:{limit:500,since:force?undefined:newest(state.rows)}}),state.browsingOlder?[]:request('websockets',{params:{summary:1,limit:500,since:force?undefined:newest(state.websockets)}})]);
        if(!active())return;
        const previousPending=JSON.stringify(state.pending.map(r=>[r.id,r.phase]));state.intercept=intercept;state.pending=(intercept.pending||[]).filter(r=>r.sessionId===sessionId);
        state.rows=mergeRows(state.rows,Array.isArray(history)?history:history.rows,sessionId).slice(-state.maxRows);state.websockets=mergeRows(state.websockets,Array.isArray(ws)?ws:ws.rows,sessionId).slice(-state.maxRows);
        const pendingChanged=previousPending!==JSON.stringify(state.pending.map(r=>[r.id,r.phase]));
        if(state.tab!=='settings'){
          if(state.tab==='intercept'&&pendingChanged){const existed=state.pending.some(r=>String(r.id)===String(state.selected));if(!existed){state.selected=null;state.selectedIds.clear();}paintRows();if(!state.selected&&state.pending.length){state.selectedIds.add(String(state.pending[0].id));selectRow(state.pending[0]);}else if(!existed){renderEmptyEditors();for(const s of ['[data-forward]','[data-drop]'])if(q(s))q(s).disabled=true;}}
          else paintRows();
          if(q('[data-intercept-toggle]'))q('[data-intercept-toggle]').textContent=`Intercept is ${interceptEnabled(intercept)?'on':'off'}`;
        }
        if(state.focus&&state.rows.length&&state.tab==='http'){const f=state.focus;const row=state.rows.filter(r=>(!f.agentId||r.agentTag===f.agentId)&&(!f.host||r.url.includes(f.host))).sort((a,b)=>Math.abs(Number(a.ts)-f.ts)-Math.abs(Number(b.ts)-f.ts))[0];if(row){state.focus=null;selectRow(row);}}
      }finally{busy=false;}
    }
    async function loadOlder(){const ws=state.tab==='websockets',rows=ws?state.websockets:state.rows;if(!rows.length)return;const before=rows[0].id;const result=await request(ws?'websockets':'history',{params:{limit:500,before,...(ws?{summary:1}:{})}});if(!active())return;const extra=Array.isArray(result)?result:result.rows||[];const previous=rows.length;state.browsingOlder=true;state[ws?'websockets':'rows']=mergeRows(rows,extra,sessionId).slice(0,state.maxRows);paintRows();q('[data-proxy-message]').textContent=state[ws?'websockets':'rows'].length===previous?'No older retained messages.':'';}
    function copy(text){if(text)navigator.clipboard.writeText(String(text)).catch(report);}
    function download(filename,content,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),0);}
    function exportMenu() {
      const backdrop=document.createElement('div');backdrop.className='modal-backdrop';
      backdrop.innerHTML=`<div class="modal" role="dialog" aria-modal="true" aria-label="Export proxy messages"><h2>Export messages</h2><p>Export ${state.selectedIds.size?'selected':'visible'} messages from ${esc(sessionName)}. Stored credentials remain redacted.</p><div class="bp-setting-actions"><button type="button" data-export-format="json">JSON</button><button type="button" data-export-format="csv">CSV</button>${state.tab==='http'?'<button type="button" data-export-format="har">HAR</button>':''}<button type="button" data-close>Cancel</button></div></div>`;
      document.body.appendChild(backdrop);modals.add(backdrop);
      const close=()=>{modals.delete(backdrop);backdrop.remove();};backdrop.querySelector('[data-close]').onclick=close;
      backdrop.onclick=e=>{if(e.target===backdrop)close();};
      backdrop.querySelectorAll('[data-export-format]').forEach(button=>button.onclick=()=>{const format=button.dataset.exportFormat;close();exportRows(format).catch(report);});
    }
    async function exportRows(format='json') {
      const rows=tableRows().filter(r=>!state.selectedIds.size||state.selectedIds.has(String(r.id)));
      const filename=`glados-proxy-${sessionId}-${state.tab}`;
      if(format==='csv') {
        const cols=columns(),csv=value=>`"${String(value??'').replace(/"/g,'""')}"`;
        download(`${filename}.csv`,[cols.map(([,label])=>csv(label)).join(','),...rows.map(row=>cols.map(([key])=>csv(cell(row,key))).join(','))].join('\r\n'),'text/csv');return;
      }
      if(format==='har') {
        const entries=[];
        for(let i=0;i<rows.length;i+=8) {
          const batch=await Promise.all(rows.slice(i,i+8).map(async row=>{
            const detail=state.details.get(String(row.id))||await request('detail',{params:{id:row.id}});
            if(detail.sessionId!==sessionId)throw new Error('Wrong session in export.');
            const headers=value=>Object.entries(value||{}).map(([name,value])=>({name,value:String(value)}));
            let queryString=[];try{queryString=[...new URL(row.url).searchParams].map(([name,value])=>({name,value}));}catch{}
            return {startedDateTime:new Date(row.ts).toISOString(),time:0,request:{method:row.method,url:row.url,httpVersion:'HTTP/1.1',headers:headers(detail.requestHeaders),queryString,cookies:[],headersSize:-1,bodySize:row.reqLen||0,...(detail.requestBody?{postData:{mimeType:'',text:detail.requestBody}}:{})},response:{status:row.status||0,statusText:(detail.statusLine||'').split(' ').slice(2).join(' '),httpVersion:'HTTP/1.1',headers:headers(detail.responseHeaders),cookies:[],content:{size:row.respLen||0,mimeType:row.mime||'',text:detail.responseBody||''},redirectURL:'',headersSize:-1,bodySize:row.respLen||0},cache:{},timings:{send:0,wait:0,receive:0},_gladosSessionId:sessionId,_gladosRedacted:true};
          }));
          if(!active())return;entries.push(...batch);
        }
        download(`${filename}.har`,JSON.stringify({log:{version:'1.2',creator:{name:'GLaDOS',version:'4.9.1'},entries}},null,2),'application/json');return;
      }
      download(`${filename}.json`,JSON.stringify({sessionId,sessionName,type:state.tab,redacted:true,messages:rows},null,2),'application/json');
    }
    function openActions(row,x,y){host.querySelector('.bp-context-menu')?.remove();const menu=document.createElement('div');menu.className='bp-context-menu';menu.style.left=`${Math.min(x,window.innerWidth-215)}px`;menu.style.top=`${Math.min(y,window.innerHeight-185)}px`;menu.innerHTML=`<button type="button" data-action="url">Copy URL</button>${state.tab==='http'?'<button type="button" data-action="replay">Replay request…</button>':''}<button type="button" data-action="agent"${row.agentTag?'':' disabled'}>Open agent conversation</button><button type="button" data-action="note">Edit notes</button>`;host.appendChild(menu);menu.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{menu.remove();if(b.dataset.action==='url')copy(row.url);if(b.dataset.action==='replay')replay(row);if(b.dataset.action==='agent')onAgent?.({...row,sessionId});if(b.dataset.action==='note')q('[data-message-notes]')?.focus();});const close=e=>{if(!menu.contains(e.target)){menu.remove();document.removeEventListener('pointerdown',close);}};document.addEventListener('pointerdown',close,{signal:abort.signal});}
    async function replay(row){
      if(!row||archived)return;try{const d=state.details.get(String(row.id))||await request('detail',{params:{id:row.id}});if(!active())return;if(d.sessionId!==sessionId)throw new Error('Wrong proxy session.');
      const backdrop=document.createElement('div');backdrop.className='modal-backdrop bp-replay';backdrop.innerHTML=`<div class="modal bp-replay-dialog" role="dialog" aria-modal="true" aria-label="Replay request"><header><h2>Replay request</h2><button type="button" data-close aria-label="Close replay">×</button></header><p>Session: ${esc(sessionName)}. Captured credentials are redacted. Supply any required test credentials before sending.</p><div class="bp-replay-url"><input data-replay-method aria-label="Replay method" value="${esc(row.method)}"><input data-replay-url aria-label="Replay URL" value="${esc(row.url)}"></div><label>Headers<textarea data-replay-headers spellcheck="false">${esc(Object.entries(d.requestHeaders||{}).map(([k,v])=>`${k}: ${v}`).join('\n'))}</textarea></label><label>Body<textarea data-replay-body spellcheck="false">${esc(d.requestBody||'')}</textarea></label><button type="button" data-send>Send</button><pre data-replay-result></pre></div>`;document.body.appendChild(backdrop);modals.add(backdrop);const close=()=>{modals.delete(backdrop);backdrop.remove();};backdrop.querySelector('[data-close]').onclick=close;backdrop.onclick=e=>{if(e.target===backdrop)close();};backdrop.querySelector('[data-send]').onclick=async e=>{e.target.disabled=true;const result=backdrop.querySelector('[data-replay-result]');result.textContent='Sending through this session’s listener…';try{const headers={};for(const line of backdrop.querySelector('[data-replay-headers]').value.split(/\r?\n/)){const match=line.match(/^([^:]+):\s*(.*)$/);if(match&&!/^(host|content-length|connection|transfer-encoding|proxy-authorization)$/i.test(match[1]))headers[match[1]]=match[2];}const r=await request('replay',{method:'POST',body:{method:backdrop.querySelector('[data-replay-method]').value,url:backdrop.querySelector('[data-replay-url]').value,headers,body:backdrop.querySelector('[data-replay-body]').value||null,agentTag:'replay'}});result.textContent=`HTTP ${r.status} ${r.statusText||''}\n${Object.entries(r.headers||{}).map(([k,v])=>`${k}: ${v}`).join('\n')}\n\n${r.body||''}`;}catch(error){result.textContent=error.message;}finally{e.target.disabled=false;}};
      }catch(error){report(error);}}
    const own={dispose(){dead=true;abort.abort();es?.close();clearInterval(timer);for(const modal of modals)modal.remove();modals.clear();host.querySelector('.bp-context-menu')?.remove();}};mounted=own;
    render();
    loadBrowserAgents().catch(report);
    timer=setInterval(()=>refresh().catch(report),2000);
    (async()=>{try{state.meta=await request('session');if(!active())return;updateMeta();state.intercept=state.meta.intercept||{};if(!archived&&!state.meta.health?.healthy){state.meta=await request('session',{method:'POST',body:{}});if(!active())return;updateMeta();}await refresh(true);if(!active())return;es=new EventSource(endpoint('stream'));es.onmessage=e=>{if(!active())return;try{const row=JSON.parse(e.data);if(row.sessionId!==sessionId||state.browsingOlder)return;if(row.type==='websocket')state.websockets=mergeRows(state.websockets,[row],sessionId).slice(-state.maxRows);else state.rows=mergeRows(state.rows,[row],sessionId).slice(-state.maxRows);if(state.tab!=='settings')paintRows();}catch{}};es.onerror=()=>{if(active())q('[data-proxy-health]').textContent='○ Reconnecting history…';};es.onopen=()=>updateMeta();}catch(error){report(error);}})();
    return own;
  }
  return {interceptEnabled,interceptSettings,apiUrl,sessionState,matches,urlParts,rawMessage,pretty,hex,mergeRows,previewRow,mount,dispose,clear,focus};
});
