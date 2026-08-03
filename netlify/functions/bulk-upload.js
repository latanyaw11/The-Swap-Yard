// The Swap Yard — Bulk Listing CSV Upload (Business Plan)
const { createClient } = require('@supabase/supabase-js');
function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = parseRow(lines[0]);
  return lines.slice(1).filter(l=>l.trim()).map(line => {
    const vals = parseRow(line);
    return headers.reduce((o,h,i)=>{o[h.trim().toLowerCase()]=(vals[i]||'').trim();return o;},{});
  });
}
function parseRow(row) {
  const cells=[]; let cur='',inQ=false;
  for(let i=0;i<row.length;i++){
    if(row[i]==='"'){inQ=!inQ;continue;}
    if(row[i]===','&&!inQ){cells.push(cur);cur='';continue;}
    cur+=row[i];
  }
  cells.push(cur); return cells;
}
const VALID_TYPES=['goods','service','digital','event'];
exports.handler=async(event)=>{
  if(event.httpMethod!=='POST')return{statusCode:405};
  const h={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  try{
    const{userId,csvContent,dryRun=false}=JSON.parse(event.body);
    if(!userId||!csvContent)return{statusCode:400,headers:h,body:JSON.stringify({error:'userId and csvContent required'})};
    const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);
    const{data:profile}=await sb.from('profiles').select('vendor_plan,display_name').eq('id',userId).single();
    if(!['business','verified_vendor','trader_pro'].includes(profile?.vendor_plan))
      return{statusCode:403,headers:h,body:JSON.stringify({error:'Bulk upload requires Trader Pro or above'})};
    const rows=parseCSV(csvContent);
    if(!rows.length)return{statusCode:400,headers:h,body:JSON.stringify({error:'No rows found'})};
    if(rows.length>500)return{statusCode:400,headers:h,body:JSON.stringify({error:'Max 500 rows'})};
    const errors=[],valid=[];
    rows.forEach((row,i)=>{
      if(!row.title){errors.push({row:i+2,error:'Title required'});return;}
      if(!VALID_TYPES.includes(row.type)){errors.push({row:i+2,error:`Invalid type: ${row.type}`});return;}
      valid.push({user_id:userId,title:row.title,description:row.description||null,type:row.type,
        category:row.category||'Other',price_usd:row.price_usd?parseFloat(row.price_usd):null,
        fmv:row.fmv?parseFloat(row.fmv):null,accepts:row.accepts?row.accepts.split(',').map(a=>a.trim()):['cash'],
        barter_for:row.barter_for||null,fulfillment:row.fulfillment||'local',city:row.city||'Durham',
        zip:row.zip||'27709',emoji:row.emoji||'📦',seller_name:profile.display_name||'@vendor',is_active:true});
    });
    if(dryRun)return{statusCode:200,headers:h,body:JSON.stringify({totalRows:rows.length,validRows:valid.length,errorRows:errors.length,errors:errors.slice(0,20),preview:valid.slice(0,3)})};
    const created=[];
    for(let i=0;i<valid.length;i+=50){
      const{data}=await sb.from('listings').insert(valid.slice(i,i+50)).select('id,title');
      created.push(...(data||[]));
    }
    return{statusCode:200,headers:h,body:JSON.stringify({success:true,created:created.length,errors:errors.length,errorDetails:errors.slice(0,20)})};
  }catch(e){return{statusCode:500,headers:h,body:JSON.stringify({error:e.message})};}
};
