import{G as R,R as A,a as H,r as T,m as c,w as j,b as w,D as F,c as O,s as q,d as W,e as B,f as D,o as G,l as N,g as Q,h as I,i as U,j as Z,k as _,P as z}from"./index-CB2ZUC2u.js";const V=`
  <div id="lab-stage" class="schematic-frame"></div>

  <div id="window-toolbar">
    <button type="button" data-toggle="lab-layers">Layers</button>
    <button type="button" data-toggle="lab-style">Style</button>
    <button type="button" data-toggle="lab-sim">Simulation</button>
    <button type="button" data-toggle="lab-ports">Ports</button>
    <button type="button" data-toggle="lab-graphics">Graphics</button>
  </div>

  <div id="lab-graphics" class="gui-window floating-window lab-window" hidden>${R}</div>

  <div id="lab-layers" class="gui-window floating-window lab-window" hidden>
    <div class="gui-titlebar"><span>Layers</span><span class="grip" aria-hidden="true"></span></div>
    <div class="gui-body"><div id="lab-layer-list" class="lab-layer-list"></div></div>
  </div>

  <div id="lab-style" class="gui-window floating-window lab-window lab-style-window" hidden>
    <div class="gui-titlebar"><span>Style</span><span class="grip" aria-hidden="true"></span></div>
    <div class="gui-body">
      <div id="lab-style-body"></div>
      <div class="lab-row lab-style-actions">
        <button type="button" id="lab-copy-settings">Copy settings</button>
        <button type="button" id="lab-reset-settings">Reset</button>
        <span class="lab-note" id="lab-copy-status"></span>
      </div>
      <textarea id="lab-settings-json" class="lab-paste" rows="6" readonly hidden></textarea>
    </div>
  </div>

  <div id="lab-sim" class="gui-window floating-window lab-window" hidden>
    <div class="gui-titlebar"><span>Simulation</span><span class="grip" aria-hidden="true"></span></div>
    <div class="gui-body">
      <div class="lab-row">
        <button type="button" id="lab-play">Pause</button>
        <div class="segmented" role="group" aria-label="Speed" id="lab-speed">
          <button type="button" data-speed="1" class="is-active">1×</button>
          <button type="button" data-speed="4">4×</button>
          <button type="button" data-speed="16">16×</button>
        </div>
        <span class="lab-clock" id="lab-clock">0:00</span>
      </div>
      <div class="lab-row">
        <button type="button" id="lab-warm">Skip ahead 60 s</button>
        <button type="button" id="lab-restart">Restart</button>
      </div>
      <div id="lab-research">${A}</div>
      <div id="lab-sim-summary" class="lab-summary"></div>
      <p class="lab-note">Belts, splitters, undergrounds and belt stacking are simulated per lane, 1:1. Machines and inserters use a rough stand-in until the simulation's second phase, so their numbers are close, not exact.</p>
    </div>
  </div>

  <div id="lab-ports" class="gui-window floating-window lab-window lab-ports-window" hidden>
    <div class="gui-titlebar"><span>Ports</span><span class="grip" aria-hidden="true"></span></div>
    <div class="gui-body">
      <p class="lab-note">Every open belt end is a port, and so is an inserter connected on one side only. Switch any of them on or off here or by clicking its tab on the map. A belt input takes its items from a constant combinator or display panel next to it, or a requester or infinity chest behind it; a belt that machines in the blueprint fill gets nothing from outside; anything else is guessed from what the machines downstream need.</p>
      <div id="lab-port-list" class="lab-port-list"></div>
    </div>
  </div>

  <div id="lab-loading" class="lab-loading">Loading game data…</div>
  <div id="lab-empty" class="lab-empty-state" hidden>
    <p>Nothing to look at yet. The lab works on the blueprint open in the Blueprint Viewer.</p>
    <a href="#/blueprint-viewer">Open the Blueprint Viewer</a>
  </div>
`;function K(o){var $;o.innerHTML=V,o.classList.add("overlay-lab-root");const e=t=>o.querySelector(t),m=new AbortController,{signal:i}=m;let f=!1,n;const L=e("#lab-stage"),a=new H(L,{cardHost:o,onUpdate:()=>h(),onPortsChange:()=>{S()&&T(e("#lab-port-list"),a)}}),p=()=>a.saveSettings(),k=Math.max(16,window.innerWidth-356),r={"lab-layers":c(e("#lab-layers"),{x:16,y:96,width:320}),"lab-style":c(e("#lab-style"),{x:k,y:96,width:340}),"lab-sim":c(e("#lab-sim"),{x:16,y:Math.max(96,window.innerHeight-330),width:320}),"lab-ports":c(e("#lab-ports"),{x:340,y:96,width:380}),"lab-graphics":c(e("#lab-graphics"),{x:k,y:96,width:340})},S=()=>!r["lab-ports"].el.hidden;for(const t of Object.values(r))t.hide();r["lab-layers"].show();const g=()=>{for(const t of o.querySelectorAll("#window-toolbar [data-toggle]"))t.classList.toggle("is-active",!r[t.dataset.toggle].el.hidden);a.forcePorts=S()};for(const t of o.querySelectorAll("#window-toolbar [data-toggle]"))t.addEventListener("click",()=>{const s=r[t.dataset.toggle];s.el.hidden?(s.show(),s.bringToFront(),t.dataset.toggle==="lab-ports"&&T(e("#lab-port-list"),a)):s.hide(),g()},{signal:i});for(const t of Object.values(r))($=t.el.querySelector(".gui-close"))==null||$.addEventListener("click",()=>queueMicrotask(g),{signal:i});g(),j(e("#lab-layer-list"),a,i);function x(t,s){const l=a.settings.style[t];return`<div class="segmented lab-seg" data-style="${t}">${s.map(d=>`<button type="button" data-value="${d.value}" class="${d.value===l?"is-active":""}">${d.label}</button>`).join("")}</div>`}function u(t,s,l,d,M){const E=a.settings.style[t];return`<div class="lab-slider"><input type="range" id="lab-s-${t}" data-style="${t}" min="${s}" max="${l}" step="${d}" value="${E}"><span class="lab-slider-value" data-value-for="${t}">${M(E)}</span></div>`}const b={laneWidth:t=>`${t.toFixed(2)} tile`,ringThickness:t=>`${t.toFixed(2)} tile`,labelScale:t=>`${t.toFixed(2)}×`,detailZoom:t=>`${Math.round(t)} px/tile`};function y(){const t=(s,l)=>`<section class="lab-group"><h3>${s}</h3>${l}</section>`;e("#lab-style-body").innerHTML=[t("Colours",x("palette",[{value:"factorio",label:"Factorio"},{value:"colorblind",label:"Colour-blind"},{value:"muted",label:"Muted"}])+`<div class="lab-swatches">${C()}</div>`),t("Sizes",'<span class="lab-field-label">Lane width</span>'+u("laneWidth",.04,.3,.01,b.laneWidth)+'<span class="lab-field-label">Machine ring and bar</span>'+u("ringThickness",.06,.4,.02,b.ringThickness)),t("Rates",x("rateUnit",[{value:"s",label:"Per second"},{value:"min",label:"Per minute"},{value:"h",label:"Per hour"}])),t("Labels and zoom",u("labelScale",.7,1.6,.05,b.labelScale)+'<span class="lab-field-label">Detail appears from</span>'+u("detailZoom",6,48,1,b.detailZoom))].join("")}function C(){const t=z[a.settings.style.palette];return[["ok","Working"],["warn","Inserter-bound"],["bad","Starved"],["held","Backed up"]].map(([s,l])=>`<span class="lab-swatch"><i style="background:${t[s]}"></i>${l}</span>`).join("")}const v=e("#lab-style-body");v.addEventListener("click",t=>{const s=t.target.closest(".lab-seg button");if(!s)return;const l=s.parentElement.dataset.style;a.settings.style[l]=s.dataset.value,p(),y(),w(e("#lab-layer-list"),a.settings)},{signal:i}),v.addEventListener("input",t=>{const s=t.target,l=s.dataset.style;if(l){if(s.type==="checkbox")a.settings.style[l]=s.checked;else{a.settings.style[l]=parseFloat(s.value);const d=v.querySelector(`[data-value-for="${l}"]`);d&&(d.textContent=b[l](parseFloat(s.value)))}p()}},{signal:i}),e("#lab-reset-settings").addEventListener("click",()=>{a.settings=structuredClone(F),p(),w(e("#lab-layer-list"),a.settings),y()},{signal:i}),e("#lab-copy-settings").addEventListener("click",()=>{const t=JSON.stringify(a.settings,null,2),s=e("#lab-copy-status"),l=e("#lab-settings-json");navigator.clipboard.writeText(t).then(()=>{s.textContent="Copied.",l.hidden=!0},()=>{s.textContent="Copy blocked. Select the text below.",l.value=t,l.hidden=!1,l.select()})},{signal:i}),w(e("#lab-layer-list"),a.settings),y();function h(){e("#lab-clock").textContent=O(a),e("#lab-play").textContent=a.playing?"Pause":"Play",e("#lab-sim-summary").innerHTML=q(a)}e("#lab-play").addEventListener("click",()=>{a.playing=!a.playing,h()},{signal:i}),e("#lab-speed").addEventListener("click",t=>{const s=t.target.closest("[data-speed]");if(s){a.speed=Number(s.dataset.speed);for(const l of e("#lab-speed").querySelectorAll("button"))l.classList.toggle("is-active",l===s);a.playing=!0,h()}},{signal:i}),e("#lab-warm").addEventListener("click",()=>a.skip(3600),{signal:i}),e("#lab-restart").addEventListener("click",()=>a.rebuild(),{signal:i}),W(e("#lab-research"),a,i),B(e("#lab-port-list"),a,i),D(e(".graphics-panel"),i);const P=G(t=>n==null?void 0:n.setQuality(t));return(async()=>{if(await N(),f)return;n=Q(L,Z(),U(),I()),a.attach(n),a.setEnabled(!0),e("#lab-loading").hidden=!0;const t=_();e("#lab-empty").hidden=t.length>0,n.loadBlueprint(t),a.load(t)})(),()=>{f=!0,m.abort(),P(),a.destroy(),n==null||n.destroy();for(const t of Object.values(r))t.destroy();o.classList.remove("overlay-lab-root"),o.innerHTML=""}}export{K as mountOverlayLab};
