// The Swap Yard — Real-Time Messaging + Email Notification
const { createClient } = require('@supabase/supabase-js');
exports.handler=async(event)=>{
  if(event.httpMethod!=='POST')return{statusCode:405};
  const h={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  try{
    const{senderId,receiverId,listingId,body,msgType='message'}=JSON.parse(event.body);
    if(!senderId||!receiverId||!body)return{statusCode:400,headers:h,body:JSON.stringify({error:'Missing fields'})};
    const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);
    const threadId=[senderId,receiverId,listingId].filter(Boolean).sort().join('-');
    const{data:message,error}=await sb.from('messages').insert({thread_id:threadId,sender_id:senderId,receiver_id:receiverId,listing_id:listingId||null,body,msg_type:msgType,is_read:false}).select().single();
    if(error)throw error;
    const{data:receiver}=await sb.from('profiles').select('email,display_name').eq('id',receiverId).single();
    if(receiver?.email&&process.env.RESEND_API_KEY){
      await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},
        body:JSON.stringify({from:process.env.FROM_EMAIL||'noreply@theswapyard.com',to:receiver.email,
          subject:'New message — The Swap Yard',
          html:`<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem"><div style="font-weight:900;margin-bottom:1rem"><span style="color:#7c3aed">The Swap</span> Yard</div><p>You have a new message:</p><div style="background:#f3f4f6;padding:1rem;border-radius:8px;margin:1rem 0;">"${body.slice(0,200)}"</div><a href="${process.env.URL||'https://theswapyard.com'}/vendor-dashboard.html" style="background:#7c3aed;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700">Reply Now →</a></div>`})});
    }
    return{statusCode:200,headers:h,body:JSON.stringify({message,threadId})};
  }catch(e){return{statusCode:500,headers:h,body:JSON.stringify({error:e.message})};}
};
