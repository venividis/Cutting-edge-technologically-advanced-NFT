/** Dependency-free WebGL scene. Geometry is actual 3D; interface remains native HTML. */
const TAU=Math.PI*2;
export const STATIONS=[
 {id:'home',label:'Sanctuary',p:[0,1.5,0]},
 {id:'circles',label:'Circles',p:[-5,1.2,2.2]},
 {id:'work',label:'Work atelier',p:[4,1.5,3]},
 {id:'agents',label:'Observatory',p:[3,2,-4]},
 {id:'tools',label:'Tool garden',p:[-3.7,1.3,-3.8]},
 {id:'saved',label:'Your library',p:[0,1,5.5]},
];
const sub=(a,b)=>a.map((v,i)=>v-b[i]),dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],norm=a=>{const l=Math.hypot(...a)||1;return a.map(v=>v/l)};
function mul(a,b){const o=new Float32Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++)for(let k=0;k<4;k++)o[c*4+r]+=a[k*4+r]*b[c*4+k];return o;}
function perspective(fov,aspect,near,far){const f=1/Math.tan(fov/2),d=1/(near-far);return new Float32Array([f/aspect,0,0,0,0,f,0,0,0,0,(far+near)*d,-1,0,0,2*far*near*d,0]);}
function lookAt(eye,target){const z=norm(sub(eye,target)),x=norm(cross([0,1,0],z)),y=cross(z,x);return new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1]);}
export function project(p,m,width,height){const v=[...p,1],r=[0,0,0,0];for(let row=0;row<4;row++)for(let k=0;k<4;k++)r[row]+=m[k*4+row]*v[k];if(r[3]<=0)return null;return [(r[0]/r[3]*.5+.5)*width,(-r[1]/r[3]*.5+.5)*height,r[2]/r[3]];}
export function makeGeometry(compatibility=false){
 const a=[];const colors={stone:[.22,.29,.30],edge:[.10,.16,.18],top:[.30,.38,.35],gold:[.77,.63,.40],pale:[.69,.73,.63],green:[.20,.48,.38],dark:[.08,.19,.16],light:[.58,.84,.69]};
 const tri=(p,q,r,c)=>{const crossN=cross(sub(q,p),sub(r,p));if(Math.hypot(...crossN)<1e-8)return;const n=norm(crossN);for(const v of [p,q,r])a.push(...v,...n,...c)};
 const box=(x,y,z,w,h,d,c)=>{const p=[[x-w/2,y,z-d/2],[x+w/2,y,z-d/2],[x+w/2,y+h,z-d/2],[x-w/2,y+h,z-d/2],[x-w/2,y,z+d/2],[x+w/2,y,z+d/2],[x+w/2,y+h,z+d/2],[x-w/2,y+h,z+d/2]];for(const f of [[0,3,2,1],[4,5,6,7],[0,4,7,3],[1,2,6,5],[3,7,6,2],[0,1,5,4]]){tri(p[f[0]],p[f[1]],p[f[2]],c);tri(p[f[0]],p[f[2]],p[f[3]],c)}};
 const cyl=(x,y,z,r1,r2,h,n,c)=>{if(compatibility)n=Math.min(n,20);for(let i=0;i<n;i++){const t=i*TAU/n,u=(i+1)*TAU/n,p=[x+Math.cos(t)*r1,y,z+Math.sin(t)*r1],q=[x+Math.cos(u)*r1,y,z+Math.sin(u)*r1],r=[x+Math.cos(t)*r2,y+h,z+Math.sin(t)*r2],s=[x+Math.cos(u)*r2,y+h,z+Math.sin(u)*r2];tri(p,r,s,c);tri(p,s,q,c);tri([x,y+h,z],s,r,c);tri([x,y,z],p,q,c)}};
 const ring=(x,y,z,r,tube,vertical,c)=>{const count=compatibility?28:72;for(let i=0;i<count;i++)for(let j=0;j<6;j++){const at=(k,l)=>{const t=k*TAU/count,u=l*TAU/6;return vertical?[x+(r+tube*Math.cos(u))*Math.cos(t),y+(r+tube*Math.cos(u))*Math.sin(t),z+tube*Math.sin(u)]:[x+(r+tube*Math.cos(u))*Math.cos(t),y+tube*Math.sin(u),z+(r+tube*Math.cos(u))*Math.sin(t)]};tri(at(i,j),at(i+1,j),at(i+1,j+1),c);tri(at(i,j),at(i+1,j+1),at(i,j+1),c)}};
 const tree=(x,y,z,s)=>{cyl(x,y,z,.065*s,.04*s,.65*s,6,colors.gold);cyl(x,y+.35*s,z,.42*s,0,.95*s,7,colors.dark);cyl(x,y+.62*s,z,.34*s,0,.75*s,7,colors.green)};
 // Faceted floating foundation and a warm, gently terraced garden.
 cyl(0,-2,0,2.8,7.8,1.7,64,colors.edge);cyl(0,-.3,0,7.8,7.8,.25,64,colors.stone);cyl(0,-.05,0,7.7,7.7,.12,64,colors.top);ring(0,.08,0,7.35,.026,false,colors.gold);
 for(const s of STATIONS){const [x,,z]=s.p;cyl(x,.08,z,1.25,1.25,.16,48,colors.pale);cyl(x,.24,z,1.05,1.05,.12,48,colors.stone);ring(x,.38,z,1,.025,false,colors.gold);}
 // Central luminous seed and open colonnade.
 cyl(0,.32,0,.85,.7,.3,48,colors.gold);cyl(0,.62,0,.7,.7,.16,48,colors.pale);
 for(let i=0;i<10;i++){const t=i*TAU/10;cyl(Math.cos(t)*1.75,.08,Math.sin(t)*1.75,.09,.075,1.25,12,colors.pale)}
 ring(0,1.35,0,1.75,.075,false,colors.gold);ring(0,2,0,.9,.034,true,colors.gold);cyl(0,1.0,0,0,.38,.62,6,colors.light);cyl(0,1.62,0,.38,0,.68,6,colors.light);
 // Circles: an amphitheatre of welcoming benches.
 for(let i=0;i<8;i++){const t=i*TAU/8;cyl(-5+Math.cos(t)*.7,.35,2.2+Math.sin(t)*.7,.22,.22,.25,16,colors.pale)}
 cyl(-5,.35,2.2,.25,.25,.35,20,colors.gold);
 // Workshop: pavilion, skylight, desks.
 for(const x of [3.3,4.7])for(const z of [2.4,3.6])cyl(x,.36,z,.07,.07,1.05,10,colors.pale);
 box(4,1.4,3,1.8,.14,1.55,colors.gold);box(4,1.54,3,.7,.16,.8,colors.green);box(4,.36,3,.9,.4,.6,colors.pale);
 // Observatory: nested orbits, not a pre-rendered illustration.
 cyl(3,.36,-4,.5,.38,1.05,20,colors.pale);ring(3,1.8,-4,.83,.045,true,colors.gold);ring(3,1.8,-4,.68,.04,false,colors.light);cyl(3,1.45,-4,.23,0,.62,8,colors.light);
 // Tool garden / treasury: vault surrounded by planted terraces.
 box(-3.7,.36,-3.8,1.15,.9,.95,colors.stone);box(-3.7,.36,-3.28,.78,.65,.08,colors.gold);ring(-3.7,.72,-3.2,.18,.025,true,colors.pale);
 // Library: steps and open shelves.
 for(let i=0;i<4;i++)box(0,.12+i*.12,5.9-i*.22,1.7,.12,.3,colors.pale);
 box(-.5,.36,5.2,.12,.8,1,colors.gold);box(.5,.36,5.2,.12,.8,1,colors.gold);box(0,1.16,5.2,1.2,.08,1.1,colors.gold);
 for(let i=0;i<7;i++)box(-.38+i*.13,.43,5.3,.08,.45+Math.sin(i)*.08,.4,i%2?colors.green:colors.pale);
 // Paths become a spatial map of available work, never token prices.
 for(const s of STATIONS.slice(1)){const [x,,z]=s.p;for(let i=2;i<10;i++){const t=i/10;cyl(x*t,.10,z*t,.08,.08,.025,12,colors.gold)}}
 let seed=37;const rand=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296);
 for(let i=0;i<(compatibility?45:105);i++){const r=2.4+rand()*4.6,t=rand()*TAU,x=Math.cos(t)*r,z=Math.sin(t)*r;if(STATIONS.some(s=>Math.hypot(x-s.p[0],z-s.p[2])<1.6))continue;tree(x,.08,z,.7+rand()*.7)}
 for(let i=0;i<26;i++){const t=i*TAU/26;cyl(Math.cos(t)*7,.08,Math.sin(t)*7,.045,.04,.3,8,colors.gold);cyl(Math.cos(t)*7,.38,Math.sin(t)*7,.07,.07,.08,8,colors.light)}
 return new Float32Array(a);
}
export function createScene(canvas,labels,{onUnavailable=()=>{}}={}){
 const gl=canvas.getContext('webgl',{alpha:true,antialias:true,powerPreference:'low-power'});
 if(!gl)return createCompatibilityScene(canvas,labels,{onUnavailable});
 canvas.dataset.renderer='webgl';
 function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}
 const p=gl.createProgram();gl.attachShader(p,shader(gl.VERTEX_SHADER,'attribute vec3 aPosition,aNormal,aColor;uniform mat4 uVP;varying vec3 vColor,vNormal,vPosition;void main(){vColor=aColor;vNormal=aNormal;vPosition=aPosition;gl_Position=uVP*vec4(aPosition,1.0);}'));gl.attachShader(p,shader(gl.FRAGMENT_SHADER,'precision mediump float;varying vec3 vColor,vNormal,vPosition;void main(){float light=.40+.60*max(dot(normalize(vNormal),normalize(vec3(-.4,.85,.6))),0.0);vec3 col=vColor*light;float mist=clamp((-vPosition.y-.1)*.13,0.0,.25);col=mix(col,vec3(.04,.10,.12),mist);gl_FragColor=vec4(col,1.0);}'));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));gl.useProgram(p);
 const vertices=makeGeometry(),buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.STATIC_DRAW);
 for(const [i,name]of ['aPosition','aNormal','aColor'].entries()){const loc=gl.getAttribLocation(p,name);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,3,gl.FLOAT,false,36,i*12)}
 const vp=gl.getUniformLocation(p,'uVP');gl.enable(gl.DEPTH_TEST);gl.clearColor(0,0,0,0);
 let angle=.55,elevation=.73,distance=21,target=[0,0,0],desired=[0,0,0],motion=!matchMedia('(prefers-reduced-motion: reduce)').matches,drag=null,frame=0,destroyed=false,dirty=true,last=0,visible=true;
 const ro=new ResizeObserver(()=>{dirty=true});ro.observe(canvas);
 const io=new IntersectionObserver(e=>{visible=e[0].isIntersecting;dirty=true});io.observe(canvas);
 function draw(t){if(destroyed)return;frame=requestAnimationFrame(draw);if(!visible||document.hidden||t-last<32)return;last=t;
  const easing=motion?.075:1;for(let i=0;i<3;i++){const d=desired[i]-target[i];if(Math.abs(d)>.0001){target[i]+=d*easing;dirty=true}}
  if(!dirty)return;dirty=false;const r=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,1.7);if(r.width<1||r.height<1)return;
  if(canvas.width!==Math.round(r.width*dpr)||canvas.height!==Math.round(r.height*dpr)){canvas.width=Math.round(r.width*dpr);canvas.height=Math.round(r.height*dpr)}
  gl.viewport(0,0,canvas.width,canvas.height);const eye=[target[0]+Math.sin(angle)*Math.cos(elevation)*distance,target[1]+Math.sin(elevation)*distance,target[2]+Math.cos(angle)*Math.cos(elevation)*distance];const matrix=mul(perspective(.73,r.width/r.height,.1,100),lookAt(eye,target));gl.uniformMatrix4fv(vp,false,matrix);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,vertices.length/9);
  for(const s of STATIONS){const el=labels.querySelector(`[data-station="${s.id}"]`),q=project(s.p,matrix,r.width,r.height);if(el&&q){el.style.transform=`translate(${q[0]}px,${q[1]}px) translate(-50%,-100%)`;el.hidden=q[2]>1||q[0]<0||q[0]>r.width||q[1]<0||q[1]>r.height;}}
 }
 const down=e=>{if(e.button!==0)return;drag=[e.clientX,e.clientY];canvas.setPointerCapture(e.pointerId);canvas.classList.add('dragging')};
 const move=e=>{if(!drag)return;angle-=(e.clientX-drag[0])*.008;elevation=Math.max(.35,Math.min(1.15,elevation+(e.clientY-drag[1])*.005));drag=[e.clientX,e.clientY];dirty=true};
 const up=()=>{drag=null;canvas.classList.remove('dragging')};
 const wheel=e=>{if(!e.ctrlKey&&!canvas.matches(':focus'))return;e.preventDefault();distance=Math.max(13,Math.min(32,distance+e.deltaY*.015));dirty=true};
 canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);canvas.addEventListener('wheel',wheel,{passive:false});
 const lost=e=>{e.preventDefault();onUnavailable()};canvas.addEventListener('webglcontextlost',lost);
 frame=requestAnimationFrame(draw);
 return {focus(id){const s=STATIONS.find(s=>s.id===id);desired=s?[s.p[0]*.12,0,s.p[2]*.12]:[0,0,0];dirty=true},setMotion(value){motion=value;dirty=true},reset(){angle=.55;elevation=.73;distance=21;desired=[0,0,0];dirty=true},destroy(){destroyed=true;cancelAnimationFrame(frame);ro.disconnect();io.disconnect();gl.deleteBuffer(buffer);gl.deleteProgram(p);canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',up);canvas.removeEventListener('wheel',wheel);canvas.removeEventListener('webglcontextlost',lost)},stats:{vertices:vertices.length/9,triangles:vertices.length/27}};
}

/** CPU fallback uses the SAME three-dimensional coordinates and perspective projection.
 * It is a painter renderer, not a static image; hidden/flat views suspend drawing.
 */
function createCompatibilityScene(canvas,labels,{onUnavailable}){
 const ctx=canvas.getContext('2d',{alpha:true});if(!ctx){onUnavailable();return {focus(){},setMotion(){},destroy(){},reset(){}}}
 canvas.dataset.renderer='projected-3d';
 const g=makeGeometry(true),faces=[],light=norm([-.4,.85,.6]);
 for(let i=0;i<g.length;i+=27){const p=Array.from(g.slice(i,i+3)),q=Array.from(g.slice(i+9,i+12)),r=Array.from(g.slice(i+18,i+21)),n=Array.from(g.slice(i+3,i+6));const k=.4+.6*Math.max(0,dot(n,light));faces.push({p,q,r,n,bucket:Math.max(p[1],q[1],r[1])<=.13?0:1,c:`rgb(${Math.round(g[i+6]*k*255)},${Math.round(g[i+7]*k*255)},${Math.round(g[i+8]*k*255)})`});}
 let angle=.55,elevation=.73,distance=21,dirty=true,drag=null,frame=0,ended=false,last=0,visible=true;
 const ro=new ResizeObserver(()=>dirty=true);ro.observe(canvas);const io=new IntersectionObserver(e=>{visible=e[0].isIntersecting;dirty=true});io.observe(canvas);
 function draw(t){if(ended)return;frame=requestAnimationFrame(draw);if(!dirty||!visible||document.hidden||t-last<65)return;last=t;const r=canvas.getBoundingClientRect();if(r.width<1||r.height<1)return;dirty=false;const dpr=Math.min(devicePixelRatio||1,1.5);canvas.width=Math.round(r.width*dpr);canvas.height=Math.round(r.height*dpr);ctx.scale(dpr,dpr);ctx.clearRect(0,0,r.width,r.height);
  const eye=[Math.sin(angle)*Math.cos(elevation)*distance,Math.sin(elevation)*distance,Math.cos(angle)*Math.cos(elevation)*distance],m=mul(perspective(.73,r.width/r.height,.1,100),lookAt(eye,[0,0,0]));
  const projected=faces.filter(f=>dot(f.n,sub(eye,f.p))>0).map(f=>{const p=project(f.p,m,r.width,r.height),q=project(f.q,m,r.width,r.height),s=project(f.r,m,r.width,r.height);return {p,q,s,c:f.c,bucket:f.bucket,z:p&&q&&s?(p[2]+q[2]+s[2])/3:-2}}).filter(f=>f.p&&f.q&&f.s).sort((a,b)=>a.bucket-b.bucket||b.z-a.z);
  for(const f of projected){ctx.fillStyle=f.c;ctx.beginPath();ctx.moveTo(f.p[0],f.p[1]);ctx.lineTo(f.q[0],f.q[1]);ctx.lineTo(f.s[0],f.s[1]);ctx.closePath();ctx.fill();}
  for(const s of STATIONS){const el=labels.querySelector(`[data-station="${s.id}"]`),q=project(s.p,m,r.width,r.height);if(el&&q){el.style.transform=`translate(${q[0]}px,${q[1]}px) translate(-50%,-100%)`;el.hidden=q[2]>1||q[0]<0||q[0]>r.width||q[1]<0||q[1]>r.height;}}
 }
 const down=e=>{if(e.button!==0)return;drag=[e.clientX,e.clientY];canvas.setPointerCapture(e.pointerId)};
 const move=e=>{if(!drag)return;angle-=(e.clientX-drag[0])*.008;elevation=Math.max(.35,Math.min(1.15,elevation+(e.clientY-drag[1])*.005));drag=[e.clientX,e.clientY];dirty=true};const up=()=>drag=null;
 const wheel=e=>{if(!e.ctrlKey&&!canvas.matches(':focus'))return;e.preventDefault();distance=Math.max(13,Math.min(32,distance+e.deltaY*.015));dirty=true};
 canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);canvas.addEventListener('wheel',wheel,{passive:false});
 frame=requestAnimationFrame(draw);
 return {focus(){dirty=true},setMotion(){},reset(){angle=.55;elevation=.73;distance=21;dirty=true},destroy(){ended=true;cancelAnimationFrame(frame);ro.disconnect();io.disconnect();canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',up);canvas.removeEventListener('wheel',wheel)},stats:{triangles:faces.length,renderer:'CPU perspective fallback'}};
}
