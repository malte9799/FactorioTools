import{G as R,R as j,a as A,r as C,m as c,w as H,b as w,D as F,c as O,o as W,d as q,e as B,f as D,g as G,l as N,h as Q,i as I,j as U,k as Z,n as _,p as z,P as J}from"./index-DjB8VZLo.js";const K=`
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
      <div id="lab-research">${j}</div>
      <div id="lab-sim-summary" class="lab-summary"></div>
      <p class="lab-note">Belts, splitters, undergrounds and belt stacking are simulated per lane, 1:1. Machines and inserters use a rough stand-in until the simulation's second phase, so their numbers are close, not exact.</p>
    </div>
  </div>

  <div id="lab-ports" class="gui-window floating-window lab-window lab-ports-window" hidden>
    <div class="gui-titlebar"><span>Ports</span><span class="grip" aria-hidden="true"></span></div>
    <div class="gui-body">
      <p class="lab-note">Every open belt end is a port, and so is an inserter connected on one side only. Click a port's tab on the map to edit just that one: switch it on or off, set what it carries, how many per stack or swing, and a rate limit (blank for none). Every port is also listed here. A belt input takes its items from a constant combinator or display panel next to it, or a requester or infinity chest behind it; a belt that machines in the blueprint fill gets nothing from outside; anything else is guessed from what the machines downstream need.</p>
      <div id="lab-port-list" class="lab-port-list"></div>
    </div>
  </div>

  <div id="lab-loading" class="lab-loading">Loading game data…</div>
  <div id="lab-empty" class="lab-empty-state" hidden>
    <p>Nothing to look at yet. The lab works on the blueprint open in the Blueprint Editor.</p>
    <a href="#/blueprint-editor">Open the Blueprint Editor</a>
  </div>
`;function X(o){var $;o.innerHTML=K,o.classList.add("overlay-lab-root");const a=t=>o.querySelector(t),m=new AbortController,{signal:i}=m;let f=!1,n;const L=a("#lab-stage"),s=new A(L,{cardHost:o,onUpdate:()=>h(),onPortsChange:()=>{x()&&C(a("#lab-port-list"),s)}}),p=()=>s.saveSettings(),k=Math.max(16,window.innerWidth-356),r={"lab-layers":c(a("#lab-layers"),{x:16,y:96,width:320}),"lab-style":c(a("#lab-style"),{x:k,y:96,width:340}),"lab-sim":c(a("#lab-sim"),{x:16,y:Math.max(96,window.innerHeight-330),width:320}),"lab-ports":c(a("#lab-ports"),{x:340,y:96,width:380}),"lab-graphics":c(a("#lab-graphics"),{x:k,y:96,width:340})},x=()=>!r["lab-ports"].el.hidden;for(const t of Object.values(r))t.hide();r["lab-layers"].show();const g=()=>{for(const t of o.querySelectorAll("#window-toolbar [data-toggle]"))t.classList.toggle("is-active",!r[t.dataset.toggle].el.hidden);s.forcePorts=x()};for(const t of o.querySelectorAll("#window-toolbar [data-toggle]"))t.addEventListener("click",()=>{const e=r[t.dataset.toggle];e.el.hidden?(e.show(),e.bringToFront(),t.dataset.toggle==="lab-ports"&&C(a("#lab-port-list"),s)):e.hide(),g()},{signal:i});for(const t of Object.values(r))($=t.el.querySelector(".gui-close"))==null||$.addEventListener("click",()=>queueMicrotask(g),{signal:i});g(),H(a("#lab-layer-list"),s,i);function S(t,e){const l=s.settings.style[t];return`<div class="segmented lab-seg" data-style="${t}">${e.map(d=>`<button type="button" data-value="${d.value}" class="${d.value===l?"is-active":""}">${d.label}</button>`).join("")}</div>`}function u(t,e,l,d,M){const E=s.settings.style[t];return`<div class="lab-slider"><input type="range" id="lab-s-${t}" data-style="${t}" min="${e}" max="${l}" step="${d}" value="${E}"><span class="lab-slider-value" data-value-for="${t}">${M(E)}</span></div>`}const b={laneWidth:t=>`${t.toFixed(2)} tile`,ringThickness:t=>`${t.toFixed(2)} tile`,labelScale:t=>`${t.toFixed(2)}×`,detailZoom:t=>`${Math.round(t)} px/tile`};function y(){const t=(e,l)=>`<section class="lab-group"><h3>${e}</h3>${l}</section>`;a("#lab-style-body").innerHTML=[t("Colours",S("palette",[{value:"factorio",label:"Factorio"},{value:"colorblind",label:"Colour-blind"},{value:"muted",label:"Muted"}])+`<div class="lab-swatches">${T()}</div>`),t("Sizes",'<span class="lab-field-label">Lane width</span>'+u("laneWidth",.04,.3,.01,b.laneWidth)+'<span class="lab-field-label">Machine ring and bar</span>'+u("ringThickness",.06,.4,.02,b.ringThickness)),t("Rates",S("rateUnit",[{value:"s",label:"Per second"},{value:"min",label:"Per minute"},{value:"h",label:"Per hour"}])),t("Labels and zoom",u("labelScale",.7,1.6,.05,b.labelScale)+'<span class="lab-field-label">Detail appears from</span>'+u("detailZoom",6,48,1,b.detailZoom))].join("")}function T(){const t=J[s.settings.style.palette];return[["ok","Working"],["warn","Inserter-bound"],["bad","Starved"],["held","Backed up"]].map(([e,l])=>`<span class="lab-swatch"><i style="background:${t[e]}"></i>${l}</span>`).join("")}const v=a("#lab-style-body");v.addEventListener("click",t=>{const e=t.target.closest(".lab-seg button");if(!e)return;const l=e.parentElement.dataset.style;s.settings.style[l]=e.dataset.value,p(),y(),w(a("#lab-layer-list"),s.settings)},{signal:i}),v.addEventListener("input",t=>{const e=t.target,l=e.dataset.style;if(l){if(e.type==="checkbox")s.settings.style[l]=e.checked;else{s.settings.style[l]=parseFloat(e.value);const d=v.querySelector(`[data-value-for="${l}"]`);d&&(d.textContent=b[l](parseFloat(e.value)))}p()}},{signal:i}),a("#lab-reset-settings").addEventListener("click",()=>{s.settings=structuredClone(F),p(),w(a("#lab-layer-list"),s.settings),y()},{signal:i}),a("#lab-copy-settings").addEventListener("click",()=>{const t=JSON.stringify(s.settings,null,2),e=a("#lab-copy-status"),l=a("#lab-settings-json");navigator.clipboard.writeText(t).then(()=>{e.textContent="Copied.",l.hidden=!0},()=>{e.textContent="Copy blocked. Select the text below.",l.value=t,l.hidden=!1,l.select()})},{signal:i}),w(a("#lab-layer-list"),s.settings),y();function h(){a("#lab-clock").textContent=O(s),a("#lab-play").textContent=s.playing?"Pause":"Play",a("#lab-sim-summary").innerHTML=W(s)}a("#lab-play").addEventListener("click",()=>{s.playing=!s.playing,h()},{signal:i}),a("#lab-speed").addEventListener("click",t=>{const e=t.target.closest("[data-speed]");if(e){s.speed=Number(e.dataset.speed);for(const l of a("#lab-speed").querySelectorAll("button"))l.classList.toggle("is-active",l===e);s.playing=!0,h()}},{signal:i}),a("#lab-warm").addEventListener("click",()=>s.skip(3600),{signal:i}),a("#lab-restart").addEventListener("click",()=>s.rebuild(),{signal:i}),q(a("#lab-research"),s,i),B(a("#lab-port-list"),s,i),D(a(".graphics-panel"),i);const P=G(t=>n==null?void 0:n.setQuality(t));return(async()=>{if(await N(),f)return;n=Q(L,Z(),U(),I()),s.attach(n),s.setEnabled(!0),a("#lab-loading").hidden=!0;const t=_();a("#lab-empty").hidden=t.length>0;const e=z();n.loadBlueprint(t,e),s.load(t,e)})(),()=>{f=!0,m.abort(),P(),s.destroy(),n==null||n.destroy();for(const t of Object.values(r))t.destroy();o.classList.remove("overlay-lab-root"),o.innerHTML=""}}export{X as mountOverlayLab};
