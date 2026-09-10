import { readFileSync } from "node:fs";
const data:any = JSON.parse(readFileSync("apps/site/public/data/game-data.json","utf8"));
const catalog:any = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json","utf8"));
const examples:any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json","utf8"));
const ctxStub:any = new Proxy({},{get(_t,p){if(p==="createPattern")return()=>({setTransform(){}});if(p==="canvas")return undefined;return()=>{};},set(){return true;}});
function el():any{const e:any={style:{},dataset:{},children:[],hidden:false,width:0,height:0,getContext:()=>ctxStub,addEventListener(){},removeEventListener(){},appendChild(c:any){e.children.push(c);return c;},replaceChildren(){},setPointerCapture(){},releasePointerCapture(){},getBoundingClientRect:()=>({left:0,top:0,width:1600,height:900,right:1600,bottom:900}),querySelector:()=>null,remove(){}};return e;}
let rafQueue:(()=>void)[]=[];
(globalThis as any).window={devicePixelRatio:1,innerWidth:1600,innerHeight:900,addEventListener(){},removeEventListener(){}};
(globalThis as any).document={createElement:()=>el(),activeElement:null};
(globalThis as any).requestAnimationFrame=(cb:()=>void)=>{rafQueue.push(cb);return 1;};
(globalThis as any).cancelAnimationFrame=()=>{};
(globalThis as any).ResizeObserver=class{observe(){}disconnect(){}};
(globalThis as any).DOMMatrix=class{scale(){return this;}};
(globalThis as any).Image=class{decoding="";private _o:any;set onload(f:any){this._o=f;queueMicrotask(()=>f?.());}get onload(){return this._o;}set onerror(_f:any){}set src(v:string){(this as any).__id=v;}decode(){return Promise.resolve();}};
const { mountRenderer } = await import("../../packages/renderer/src/render.js");
const { collectBlueprints, decodeBlueprintString, normaliseEntities } = await import("../../packages/engine/src/index.js");
const r = mountRenderer(el(), data, catalog);
const pump=(n=1)=>{for(let i=0;i<n;i++){const q=rafQueue;rafQueue=[];for(const cb of q)cb();}};
const ex=[...examples].sort((a,b)=>b.entities-a.entities)[0];
const ents=collectBlueprints(decodeBlueprintString(ex.bp)).map(normaliseEntities).sort((a:any,b:any)=>b.length-a.length)[0]!;
r.loadBlueprint(ents); pump(3); await new Promise(x=>setTimeout(x,80)); pump(3);
for (let i=0;i<6;i++){
  const before=r.getDebugStats();
  pump(1);
  const after=r.getDebugStats();
  console.log(`Frame ${i}: drawn ${before.framesDrawn}->${after.framesDrawn}  skipped ${before.framesSkipped}->${after.framesSkipped}  rebuilds ${before.sceneRebuildCount}->${after.sceneRebuildCount}`);
}
r.destroy();
