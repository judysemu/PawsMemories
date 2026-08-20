#!/usr/bin/env node
/**
 * Renders frames of whatever clip is currently loaded in the Azure Blender
 * worker, so an authored clip can be eyeballed without a local Blender.
 *
 *   npx tsx scripts/manual/author-barkley-clip.ts point_right --out /tmp/clips
 *   node scripts/manual/render-clip-frames.mjs 0 24 34
 *   node scripts/manual/render-clip-frames.mjs 10 24 --head   # head closeup
 *
 * The worker has no /viewport route; this drives a Workbench render through
 * /execute and returns the PNG as base64 on stdout.
 */
import 'dotenv/config';
import fs from 'fs';
const U=process.env.BLENDER_WORKER_URL||'https://pawsome3d-blender-worker.ambitiousforest-08789dd3.eastus.azurecontainerapps.io';
const S=(process.env.WORKER_SHARED_SECRET||'').trim();
const args=process.argv.slice(2);
const HEAD=args.includes('--head');
const frames=args.filter(a=>a!=='--head').map(Number);
const py=(f)=>`
import bpy, base64, math
sc=bpy.context.scene
sc.render.engine='BLENDER_WORKBENCH'
sc.render.resolution_x=640; sc.render.resolution_y=640; sc.render.resolution_percentage=100
sc.render.film_transparent=False
sc.render.image_settings.file_format='PNG'
cam=bpy.data.objects.get('__probe_cam')
if cam is None:
    cd=bpy.data.cameras.new('__probe_cam'); cam=bpy.data.objects.new('__probe_cam',cd); sc.collection.objects.link(cam)
sc.camera=cam
# Frame the armature from the front (-Y), looking at mid-height.
objs=[o for o in sc.objects if o.type=='MESH']
zs=[]
for o in objs:
    vs=o.data.vertices; n=len(vs)
    for i in range(0,n,max(1,n//400)):
        zs.append((o.matrix_world @ vs[i].co).z)
if not zs: zs=[0.0,1.0]
lo,hi=min(zs),max(zs); h=max(hi-lo,0.1); mid=(lo+hi)/2
arm=[o for o in sc.objects if o.type=='ARMATURE'][0]
sc.frame_set(${f})
bpy.context.view_layer.update()
if ${HEAD?'True':'False'}:
    hz=(arm.matrix_world @ arm.pose.bones['Head'].head).z
    cam.location=(0.0,-0.62,hz+0.02); cam.data.lens=70
else:
    cam.location=(0.0, -h*1.75, mid); cam.data.lens=50
cam.rotation_euler=(math.radians(90),0,0)
cam.data.sensor_width=36
sc.render.filepath='/tmp/f${f}.png'
bpy.ops.render.render(write_still=True)
print('IMG', base64.b64encode(open('/tmp/f${f}.png','rb').read()).decode())
`;
for (const f of frames){
  const r=await fetch(U+'/execute',{method:'POST',headers:{'Content-Type':'application/json','x-worker-secret':S},body:JSON.stringify({code:py(f)})});
  const j=await r.json();
  const line=String(j.stdout||'').split('\n').find(l=>l.startsWith('IMG '));
  if(!line){console.log('frame',f,'FAILED',(j.error||j.stderr||JSON.stringify(j)).slice(0,400));continue;}
  fs.mkdirSync('/tmp/clips',{recursive:true});
  fs.writeFileSync(`/tmp/clips/pr2_f${f}.png`,Buffer.from(line.slice(4),'base64'));
  console.log('frame',f,'rendered');
}
