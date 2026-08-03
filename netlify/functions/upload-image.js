// The Swap Yard — Image Upload to Supabase Storage
const { createClient } = require('@supabase/supabase-js');
exports.handler=async(event)=>{
  if(event.httpMethod!=='POST')return{statusCode:405};
  const h={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  try{
    const{userId,listingId,imageBase64,mimeType='image/jpeg',fileName}=JSON.parse(event.body);
    if(!userId||!imageBase64)return{statusCode:400,headers:h,body:JSON.stringify({error:'userId and imageBase64 required'})};
    const buffer=Buffer.from(imageBase64,'base64');
    if(buffer.length>5*1024*1024)return{statusCode:400,headers:h,body:JSON.stringify({error:'Image must be under 5MB'})};
    const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);
    const ext=mimeType.split('/')[1]||'jpg';
    const path=`${userId}/${listingId||'draft'}/${Date.now()}.${ext}`;
    const{error}=await sb.storage.from('listing-images').upload(path,buffer,{contentType:mimeType,upsert:false});
    if(error)throw error;
    const{data:urlData}=sb.storage.from('listing-images').getPublicUrl(path);
    if(listingId){
      const{data:listing}=await sb.from('listings').select('images').eq('id',listingId).single();
      const images=[...(listing?.images||[]),urlData.publicUrl];
      await sb.from('listings').update({images}).eq('id',listingId);
    }
    return{statusCode:200,headers:h,body:JSON.stringify({url:urlData.publicUrl,path})};
  }catch(e){return{statusCode:500,headers:h,body:JSON.stringify({error:e.message})};}
};
