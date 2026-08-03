// The Swap Yard — Premium Listing Boosts + Referral Program
const Stripe=require('stripe');
const{createClient}=require('@supabase/supabase-js');
const TIERS={basic:{price:299,days:3,label:'Basic Boost'},featured:{price:599,days:7,label:'Featured'},premium:{price:999,days:14,label:'Premium Plus'}};
exports.handler=async(event)=>{
  if(event.httpMethod!=='POST')return{statusCode:405};
  const h={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  try{
    const{action,...params}=JSON.parse(event.body);
    const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);
    const stripe=Stripe(process.env.STRIPE_SECRET_KEY);
    if(action==='get_referral_code'){
      const{userId}=params;
      const{data:profile}=await sb.from('profiles').select('referral_code,referral_credits,referral_count').eq('id',userId).single();
      if(!profile?.referral_code){
        const code='TSY-'+userId.slice(0,6).toUpperCase()+'-'+Math.random().toString(36).slice(2,6).toUpperCase();
        await sb.from('profiles').update({referral_code:code}).eq('id',userId);
        return{statusCode:200,headers:h,body:JSON.stringify({code,credits:0,count:0,shareUrl:`${process.env.URL}?ref=${code}`})};
      }
      return{statusCode:200,headers:h,body:JSON.stringify({code:profile.referral_code,credits:profile.referral_credits||0,count:profile.referral_count||0,shareUrl:`${process.env.URL}?ref=${profile.referral_code}`})};
    }
    if(action==='apply_referral'){
      const{userId,referralCode}=params;
      const{data:referrer}=await sb.from('profiles').select('id,referral_credits,referral_count').eq('referral_code',referralCode).single();
      if(!referrer||referrer.id===userId)return{statusCode:400,headers:h,body:JSON.stringify({error:'Invalid code'})};
      await sb.from('profiles').update({referred_by:referrer.id,listing_credits:500}).eq('id',userId);
      await sb.from('profiles').update({referral_credits:(referrer.referral_credits||0)+500,referral_count:(referrer.referral_count||0)+1}).eq('id',referrer.id);
      await sb.from('referrals').insert({referrer_id:referrer.id,referred_id:userId,status:'pending',code:referralCode});
      return{statusCode:200,headers:h,body:JSON.stringify({success:true,creditApplied:500})};
    }
    if(action==='boost_listing'){
      const{userId,listingId,tier}=params;
      const boostTier=TIERS[tier];
      if(!boostTier)return{statusCode:400,headers:h,body:JSON.stringify({error:'Invalid tier'})};
      const{data:listing}=await sb.from('listings').select('title,user_id').eq('id',listingId).single();
      if(!listing||listing.user_id!==userId)return{statusCode:403,headers:h,body:JSON.stringify({error:'Not your listing'})};
      const session=await stripe.checkout.sessions.create({payment_method_types:['card'],line_items:[{price_data:{currency:'usd',product_data:{name:`${boostTier.label} — "${listing.title}"`},unit_amount:boostTier.price},quantity:1}],mode:'payment',success_url:`${process.env.URL}/vendor-dashboard.html?boost=success`,cancel_url:`${process.env.URL}/vendor-dashboard.html`,metadata:{listingId,userId,tier,action:'boost'}});
      return{statusCode:200,headers:h,body:JSON.stringify({checkoutUrl:session.url})};
    }
    return{statusCode:400,headers:h,body:JSON.stringify({error:'Unknown action'})};
  }catch(e){return{statusCode:500,headers:h,body:JSON.stringify({error:e.message})};}
};
