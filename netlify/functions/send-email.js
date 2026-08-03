// The Swap Yard — Email Notifications via Resend
exports.handler=async(event)=>{
  if(event.httpMethod!=='POST')return{statusCode:405};
  const h={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  try{
    const{to,subject,html,type,data}=JSON.parse(event.body);
    if(!to)return{statusCode:400,headers:h,body:JSON.stringify({error:'to required'})};
    if(!process.env.RESEND_API_KEY)return{statusCode:503,headers:h,body:JSON.stringify({error:'Email not configured'})};
    const wrap=c=>`<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden"><div style="background:linear-gradient(135deg,#111827,#2d1b69);padding:1.5rem 2rem"><span style="font-size:1.1rem;font-weight:900;color:#fff"><span style="color:#a855f7">The Swap</span> Yard</span></div><div style="padding:2rem">${c}</div><div style="background:#f3f4f6;padding:1rem 2rem;font-size:.72rem;color:#9ca3af;text-align:center">The Swap Yard · theswapyard.com</div></div>`;
    const templates={
      new_message:d=>`<h2 style="margin-bottom:.5rem">💬 New Message</h2><p style="color:#374151">You have a new message${d.listingTitle?` about <strong>${d.listingTitle}</strong>`:''}</p>${d.preview?`<div style="background:#f3f4f6;padding:1rem;border-radius:8px;margin:1rem 0">"${d.preview}"</div>`:''}<a href="${process.env.URL||'https://theswapyard.com'}/vendor-dashboard.html" style="display:inline-block;background:#7c3aed;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700">Reply Now →</a>`,
      order_placed:d=>`<h2>🎉 You Made a Sale!</h2><p style="color:#374151"><strong>${d.buyerEmail||'A buyer'}</strong> purchased <strong>${d.listingTitle||'your item'}</strong></p><div style="background:rgba(5,150,105,.08);border:1px solid rgba(5,150,105,.2);border-radius:8px;padding:1rem;margin:1rem 0;text-align:center"><div style="font-size:1.5rem;font-weight:900;color:#059669">$${d.amount}</div></div><a href="${process.env.URL||'https://theswapyard.com'}/vendor-dashboard.html" style="display:inline-block;background:#059669;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700">View Order →</a>`,
      order_shipped:d=>`<h2>📦 Your Order Shipped</h2><p style="color:#374151"><strong>${d.listingTitle||'Your item'}</strong> is on its way!</p><div style="background:#eff6ff;border:1px solid #bfdbfe;padding:1rem;border-radius:8px;margin:1rem 0"><div style="font-weight:700;font-family:monospace">${d.trackingCode}</div><div style="font-size:.8rem;color:#374151">via ${d.carrier||'carrier'}</div></div><a href="${d.trackingUrl||'#'}" style="display:inline-block;background:#2563eb;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700">Track Package →</a>`,
      trade_offer:d=>`<h2>⇄ New Trade Offer</h2><p style="color:#374151"><strong>${d.offerName||'Someone'}</strong> wants to trade for your <strong>${d.listingTitle||'listing'}</strong></p><div style="background:rgba(217,119,6,.08);border:1px solid rgba(217,119,6,.2);padding:1rem;border-radius:8px;margin:1rem 0"><div style="font-weight:700">${d.offerItem||'See listing'}</div></div><a href="${process.env.URL||'https://theswapyard.com'}/vendor-dashboard.html" style="display:inline-block;background:#d97706;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700">View Offer →</a>`,
      referral_earned:d=>`<h2>🎁 Referral Credit!</h2><p style="color:#374151"><strong>${d.referredName||'Someone'}</strong> joined using your referral link.</p><div style="text-align:center;padding:1.5rem;background:rgba(5,150,105,.08);border-radius:8px;margin:1rem 0"><div style="font-size:2rem;font-weight:900;color:#059669">+$${((d.credits||500)/100).toFixed(2)}</div></div>`,
    };
    const emailHtml=html||(type&&templates[type]?wrap(templates[type](data||{})):wrap(`<p>${JSON.stringify(data)}</p>`));
    const res=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.FROM_EMAIL||'noreply@theswapyard.com',to,subject:subject||'Notification — The Swap Yard',html:emailHtml})});
    const result=await res.json();
    if(!res.ok)throw new Error(result.message);
    return{statusCode:200,headers:h,body:JSON.stringify({sent:true,id:result.id})};
  }catch(e){return{statusCode:500,headers:h,body:JSON.stringify({error:e.message})};}
};
