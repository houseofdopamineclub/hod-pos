function renderWalletPage(bookingRef){
  var wrap=document.createElement('div');
  wrap.className='hod-wallet-v2';
  wrap.style.cssText='min-height:100vh;background:#0A0A0A;color:#F5F1E8;font-family:var(--fs);padding-bottom:90px;';

  // ── Inject scoped Digitory-style theme (red+yellow+black). Re-themes the
  //    entire wallet page in one place via CSS-var overrides + targeted
  //    overrides for the most common gold/dark inline styles. Scoped to
  //    .hod-wallet-v2 so the public site's gold theme is untouched.
  if(!document.getElementById('hod-wallet-v2-css')){
    var st=document.createElement('style');st.id='hod-wallet-v2-css';
    st.textContent=
      '.hod-wallet-v2{--gold:#F2C744;--goldg:linear-gradient(135deg,#F2C744,#B8941F);--text:#F5F1E8;--muted:#9A9A9A;--card:#141414;--surface:#1F1F1F;--border:rgba(242,199,68,.18);--red:#B83227;--red-deep:#8C2419;}'
      // Lift hardcoded dark-blue panels (#0C0C18 etc.) and rgba(255,255,255,.03) into proper Digitory blacks
      +'.hod-wallet-v2 input,.hod-wallet-v2 button,.hod-wallet-v2 select,.hod-wallet-v2 textarea{font-family:var(--fs);}'
      +'.hod-wallet-v2 input::placeholder{color:#777;}'
      // QR wrap → white card for crisp scan
      +'.hod-wallet-v2 #wallet-qr-wrap,.hod-wallet-v2 #wallet-qr-wait,.hod-wallet-v2 #conf-qr-wrap{background:#fff !important;width:180px !important;height:180px !important;border:6px solid #fff !important;border-radius:14px !important;box-shadow:0 4px 22px rgba(242,199,68,.18);}'
      // Item row dividers — thin red dotted (Digitory)
      +'.hod-wallet-v2 .wv-row{border-bottom:1px dashed rgba(184,50,39,.22) !important;padding:14px 4px !important;}'
      // ADD button — bold red with yellow text
      +'.hod-wallet-v2 .wv-add{padding:9px 22px !important;border-radius:10px !important;background:#B83227 !important;border:1px solid #B83227 !important;color:#F2C744 !important;font-size:13px !important;font-weight:900 !important;letter-spacing:.5px;text-transform:uppercase;cursor:pointer;font-family:var(--fs);box-shadow:0 2px 10px rgba(184,50,39,.35);transition:transform .15s,box-shadow .15s;}'
      +'.hod-wallet-v2 .wv-add:active{transform:scale(.96);}'
      +'.hod-wallet-v2 .wv-add:hover{background:#F2C744 !important;color:#0A0A0A !important;border-color:#F2C744 !important;}'
      // Qty stepper buttons
      +'.hod-wallet-v2 .wv-qbtn{width:32px !important;height:32px !important;border-radius:8px !important;background:#1F1F1F !important;border:1.5px solid #B83227 !important;color:#F2C744 !important;font-size:16px !important;font-weight:900;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:var(--fs);}'
      +'.hod-wallet-v2 .wv-qbtn:hover{background:#B83227 !important;}'
      +'.hod-wallet-v2 .wv-qty{font-family:var(--fs);font-size:15px;font-weight:900;color:#F2C744;min-width:22px;text-align:center;}'
      // Category accordion header — bold black panel with yellow underline
      +'.hod-wallet-v2 .wv-cat{background:#141414 !important;border:1px solid rgba(242,199,68,.22) !important;border-left:4px solid #B83227 !important;border-radius:8px !important;padding:14px 16px !important;cursor:pointer;}'
      +'.hod-wallet-v2 .wv-cat .wv-cat-name{font-size:13px !important;font-weight:900 !important;color:#F2C744 !important;letter-spacing:1.6px !important;text-transform:uppercase;}'
      +'.hod-wallet-v2 .wv-cat .wv-cat-count{font-size:11px;color:#9A9A9A;font-weight:700;letter-spacing:.5px;}'
      // Tab buttons — yellow solid active, deep-red outlined inactive
      +'.hod-wallet-v2 .wv-tab{flex:1;padding:18px 8px !important;border-radius:12px !important;font-size:13px !important;font-weight:900 !important;letter-spacing:1.4px;text-transform:uppercase;cursor:pointer;font-family:var(--fs);border:2px solid !important;transition:all .15s;}'
      +'.hod-wallet-v2 .wv-tab.on{background:#F2C744 !important;border-color:#F2C744 !important;color:#0A0A0A !important;box-shadow:0 4px 16px rgba(242,199,68,.3);}'
      +'.hod-wallet-v2 .wv-tab.off{background:transparent !important;border-color:#B83227 !important;color:#F5F1E8 !important;}'
      +'.hod-wallet-v2 .wv-tab.off:hover{background:rgba(184,50,39,.18) !important;}'
      // Sticky bottom View Cart bar — Digitory red
      +'.hod-wallet-v2 .wv-stickycart{position:fixed;left:0;right:0;bottom:0;z-index:200;background:#B83227;color:#F2C744;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;font-family:var(--fs);font-weight:900;font-size:15px;letter-spacing:.4px;box-shadow:0 -8px 24px rgba(0,0,0,.5);cursor:pointer;}'
      +'.hod-wallet-v2 .wv-stickycart .wv-sc-amt{font-family:var(--fp);font-size:20px;color:#fff;}'
      // Search input — yellow outline on black
      +'.hod-wallet-v2 .wv-search{width:100%;padding:14px 16px !important;border-radius:12px !important;background:#0A0A0A !important;border:2px solid rgba(242,199,68,.45) !important;color:#F5F1E8 !important;font-size:14px !important;font-weight:600;font-family:var(--fs);outline:none;box-sizing:border-box;letter-spacing:.3px;}'
      +'.hod-wallet-v2 .wv-search:focus{border-color:#F2C744 !important;box-shadow:0 0 0 3px rgba(242,199,68,.12);}'
      // Header strip
      +'.hod-wallet-v2 .wv-hdr{background:#000 !important;border-bottom:2px solid #B83227 !important;padding:14px 18px !important;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;}'
      +'.hod-wallet-v2 .wv-hdr-brand{font-family:var(--fp);font-size:24px;font-weight:900;color:#F2C744;letter-spacing:3px;}'
      +'.hod-wallet-v2 .wv-hdr-pill{display:inline-block;padding:7px 14px;border-radius:999px;background:#B83227;color:#F2C744;font-size:11px;font-weight:900;letter-spacing:1.2px;text-transform:uppercase;border:none;cursor:pointer;font-family:var(--fs);}'
      // Wallet hero card — red-to-black with yellow balance
      +'.hod-wallet-v2 .wv-wcard{background:linear-gradient(135deg,#B83227 0%,#7a1f17 60%,#1a0a08 100%) !important;border:1.5px solid #F2C744 !important;border-radius:18px !important;padding:24px !important;margin-bottom:18px;color:#fff;box-shadow:0 8px 32px rgba(184,50,39,.25);}'
      +'.hod-wallet-v2 .wv-wcard .wv-bal{font-family:var(--fp);font-size:44px;font-weight:900;color:#F2C744;line-height:1;letter-spacing:-1px;}'
      +'.hod-wallet-v2 .wv-wcard .wv-bal.zero{color:#fff;opacity:.6;}'
      // Place order primary button — yellow solid
      +'.hod-wallet-v2 .wv-place{width:100%;padding:18px !important;border-radius:14px !important;background:#F2C744 !important;border:2px solid #F2C744 !important;color:#0A0A0A !important;font-size:15px !important;font-weight:900 !important;letter-spacing:1.2px !important;text-transform:uppercase;cursor:pointer;font-family:var(--fs);box-shadow:0 6px 22px rgba(242,199,68,.32);}'
      +'.hod-wallet-v2 .wv-place:disabled,.hod-wallet-v2 .wv-place[style*="opacity:.45"]{opacity:.4;}'
      // Veg dot crisp
      +'.hod-wallet-v2 .wv-vegdot{width:11px !important;height:11px !important;border-radius:2px !important;border:1.5px solid currentColor;display:inline-flex;align-items:center;justify-content:center;margin-right:8px;}'
      +'.hod-wallet-v2 .wv-vegdot::after{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;display:block;}'
      // Force gold→yellow for any remaining var(--gold) references inside QR-bg circles etc.
      +'.hod-wallet-v2{color-scheme:dark;}'
      // ── DIGITORY V3 ADDITIONS ─────────────────────────
      // Full-bleed deep red header strip (replaces black wv-hdr style)
      +'.hod-wallet-v2 .wv-hdr2{background:#B83227 !important;color:#fff;padding:14px 18px !important;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;}'
      +'.hod-wallet-v2 .wv-hdr2 .wv-hd2-brand{font-size:13px;font-weight:900;letter-spacing:1.4px;text-transform:uppercase;line-height:1.2;color:#fff;}'
      +'.hod-wallet-v2 .wv-hdr2 .wv-hd2-otp{font-size:12px;font-weight:700;color:rgba(255,255,255,.92);letter-spacing:.4px;margin-top:2px;font-family:var(--fp);}'
      +'.hod-wallet-v2 .wv-hdr2 .wv-hd2-otp b{color:#F2C744;letter-spacing:1.5px;font-weight:900;}'
      +'.hod-wallet-v2 .wv-hdr2 .wv-hd2-call{display:flex;align-items:center;gap:8px;color:#fff;font-size:12px;font-weight:700;letter-spacing:.4px;cursor:pointer;background:transparent;border:none;font-family:var(--fs);}'
      +'.hod-wallet-v2 .wv-hdr2 .wv-hd2-avatar{width:26px;height:26px;border-radius:50%;background:#F2C744;color:#B83227;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;}'
      // 4-tab solid rectangles like Digitory FOOD/LIQUOR/NAB/SMOKE
      +'.hod-wallet-v2 .wv-tab4row{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:14px;}'
      +'.hod-wallet-v2 .wv-tab4{padding:22px 6px;border-radius:8px;font-size:12px;font-weight:900;letter-spacing:1.6px;text-transform:uppercase;cursor:pointer;font-family:var(--fs);border:none;text-align:center;transition:all .12s;color:#fff;background:#B83227;line-height:1.1;box-shadow:0 1px 4px rgba(0,0,0,.4);}'
      +'.hod-wallet-v2 .wv-tab4.on{background:#F2C744 !important;color:#0A0A0A !important;font-weight:900;box-shadow:0 4px 14px rgba(242,199,68,.32);}'
      +'.hod-wallet-v2 .wv-tab4:active{transform:scale(.97);}'
      // Filters bar (deep red row above tabs)
      +'.hod-wallet-v2 .wv-filters{background:#8C2419;color:#fff;padding:13px 16px;border-radius:6px;display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;cursor:pointer;font-size:13px;font-weight:700;letter-spacing:.6px;text-transform:none;}'
      +'.hod-wallet-v2 .wv-filters .wv-fl-arrow{font-size:11px;opacity:.85;transition:transform .15s;}'
      +'.hod-wallet-v2 .wv-filters.open .wv-fl-arrow{transform:rotate(180deg);}'
      +'.hod-wallet-v2 .wv-filters-panel{display:none;background:#0F0F0F;border:1px solid rgba(184,50,39,.4);border-radius:6px;padding:12px 14px;margin-bottom:10px;gap:8px;flex-wrap:wrap;}'
      +'.hod-wallet-v2 .wv-filters-panel.open{display:flex;}'
      +'.hod-wallet-v2 .wv-fchip{padding:8px 14px;border-radius:999px;background:#1F1F1F;border:1.5px solid rgba(242,199,68,.3);color:#F5F1E8;font-size:12px;font-weight:700;letter-spacing:.4px;cursor:pointer;font-family:var(--fs);text-transform:uppercase;}'
      +'.hod-wallet-v2 .wv-fchip.on{background:#F2C744;color:#0A0A0A;border-color:#F2C744;}'
      // Sub-category chip row (wrapped)
      +'.hod-wallet-v2 .wv-subrow{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-bottom:18px;padding:0 4px;}'
      +'.hod-wallet-v2 .wv-subchip{padding:7px 12px;border-radius:6px;background:transparent;border:1px solid transparent;color:rgba(245,241,232,.85);font-size:11px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;cursor:pointer;font-family:var(--fs);transition:all .12s;}'
      +'.hod-wallet-v2 .wv-subchip:hover{color:#F2C744;}'
      +'.hod-wallet-v2 .wv-subchip.on{border-color:#F2C744;color:#F2C744;background:rgba(242,199,68,.04);}'
      // Section title above item list (e.g. "MANGO MANIA")
      +'.hod-wallet-v2 .wv-sectiontitle{font-family:var(--fp);font-size:24px;font-weight:900;color:#F5F1E8;letter-spacing:1.2px;text-transform:uppercase;margin:18px 4px 14px;}'
      // Bottom fixed View Cart footer (red strip)
      +'.hod-wallet-v2 .wv-cartfooter{position:fixed;left:0;right:0;bottom:0;z-index:200;background:#B83227;padding:0;font-family:var(--fs);box-shadow:0 -8px 24px rgba(0,0,0,.5);display:none;}'
      +'.hod-wallet-v2 .wv-cartfooter.show{display:block;}'
      +'.hod-wallet-v2 .wv-cartfooter .wv-cf-tax{text-align:center;background:#0A0A0A;color:rgba(245,241,232,.55);font-size:11px;padding:7px 12px;letter-spacing:.4px;font-style:italic;}'
      +'.hod-wallet-v2 .wv-cartfooter .wv-cf-btn{width:100%;padding:16px;background:#B83227;color:#F2C744;font-size:15px;font-weight:900;letter-spacing:1.4px;text-transform:uppercase;border:none;cursor:pointer;font-family:var(--fs);display:flex;align-items:center;justify-content:center;gap:10px;}'
      +'.hod-wallet-v2 .wv-cartfooter .wv-cf-btn .wv-cf-amt{background:#0A0A0A;color:#F2C744;padding:5px 10px;border-radius:6px;font-family:var(--fp);font-size:14px;font-weight:900;letter-spacing:.5px;}'
      // Reserve bottom space so the fixed footer never covers content
      +'.hod-wallet-v2{padding-bottom:90px;}';
    document.head.appendChild(st);
  }

  // Header — Digitory deep-red strip with venue name + ref/OTP left,
  // Call Waiter + avatar on the right. Ref defaults to wallet/booking ref.
  // OTP only shown if cv has one (post-checkin); otherwise just the ref.
  var hdr=document.createElement('div');
  hdr.className='wv-hdr2';
  // Build header lazily after we know cv — start with just brand.
  hdr.innerHTML='<div><div class="wv-hd2-brand">House of Dopamine</div>'
    +'<div class="wv-hd2-otp" id="wv-hd2-ref">&nbsp;</div></div>'
    +'<button class="wv-hd2-call" onclick="window.location.href=\'tel:+918882222900\'">'
      +'<span>Call Waiter</span><span class="wv-hd2-avatar">&#9742;</span>'
    +'</button>';
  wrap.appendChild(hdr);

  var inner=document.createElement('div');
  inner.style.cssText='padding:20px;max-width:480px;margin:0 auto;';
  wrap.appendChild(inner);

  // Loading state
  var loadDiv=document.createElement('div');
  loadDiv.style.cssText='text-align:center;padding:60px 20px;color:var(--muted);';
  loadDiv.innerHTML='<div style="border:2px solid rgba(242,199,68,.2);border-top-color:var(--gold);border-radius:50%;width:28px;height:28px;animation:spin .7s linear infinite;margin:0 auto 14px;"></div>Loading your wallet...';
  inner.appendChild(loadDiv);

  // Cart state
  var cart={};
  var cartTotal=0;

  // Inclusive grand total (food+drink+SC+GST). Customer sees ONLY this number — never the breakdown.
  function getCartTotal(){return hodComputeBreakdown(Object.values(cart)).grandTotal;}

  function renderWalletContent(cv){
    inner.innerHTML='';
    var bal=cv.coverBalance||0;
    var activated=cv.coverActivated||0;
    var used=cv.coverUsed||0;
    var name=cv.name||'Guest';

    // Wallet card
    if(!cv.isTableBooking){
    var wCard=document.createElement('div');
    wCard.className='wv-wcard';
    var pct=activated>0?Math.round((used/activated)*100):0;
    wCard.innerHTML='<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;">'
      +'<div><div style="font-size:11px;font-weight:800;color:#F2C744;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;opacity:.85;">Cover Wallet</div>'
      +'<div style="font-size:20px;font-weight:900;color:#fff;letter-spacing:-.3px;">'+sanitize(name)+'</div>'
      +'<div style="font-size:11px;color:rgba(255,255,255,.7);margin-top:3px;letter-spacing:.5px;">'+sanitize(cv.eventTitle||'HOD · Tonight')+'</div></div>'
      +'<div style="text-align:right;"><div style="font-size:10px;color:rgba(255,255,255,.7);margin-bottom:4px;letter-spacing:1.2px;text-transform:uppercase;">Available</div>'
      +'<div class="wv-bal'+(bal<=0?' zero':'')+'">\u20b9'+bal.toLocaleString('en-IN')+'</div></div></div>'
      +'<div style="background:rgba(0,0,0,.45);border-radius:6px;overflow:hidden;height:8px;margin-bottom:8px;">'
      +'<div style="height:100%;background:linear-gradient(90deg,#F2C744,#fff);width:'+Math.max(0,100-pct)+'%;transition:width .5s;border-radius:6px;box-shadow:0 0 8px rgba(242,199,68,.5);"></div></div>'
      +'<div style="display:flex;justify-content:space-between;font-size:11px;color:rgba(255,255,255,.7);font-weight:600;letter-spacing:.3px;">'
      +'<span>\u20b9'+used.toLocaleString('en-IN')+' used</span><span>\u20b9'+activated.toLocaleString('en-IN')+' total</span></div>';
    inner.appendChild(wCard);
    } // end if(!isTableBooking)

    // Table booking info banner
    if(cv.isTableBooking){
      var tbBanner=document.createElement('div');
      tbBanner.style.cssText='background:rgba(242,199,68,.08);border:1px solid rgba(242,199,68,.2);border-radius:14px;padding:14px 16px;margin-bottom:14px;';
      tbBanner.innerHTML='<div style="font-size:11px;font-weight:800;color:var(--gold);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">🪑 Table Reservation · Pre-Order Menu</div>'
        +'<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--muted);">'
        +'<span>📍 <b style="color:var(--text);">'+sanitize(cv.tableId||'')+'</b> · '+sanitize(cv.floorLabel||'')+'</span>'
        +'<span>📅 <b style="color:var(--text);">'+sanitize(cv.date||'')+'</b></span>'
        +'<span>🕐 <b style="color:var(--text);">'+sanitize(cv.arrivalTime||'')+'</b></span>'
        +'<span>👥 <b style="color:var(--text);">'+sanitize(String(cv.partySize||0))+'</b> guests</span>'
        +'</div>'
        +(bal<=0?'<div style="margin-top:8px;font-size:11px;color:rgba(242,199,68,.7);">💰 Pre-order below — pay via cash, card or UPI at your table.</div>':'')
        ;
      inner.appendChild(tbBanner);
    }

    // Expiry check — date-based or expiresAt
    var _cvDate2=cv.date||cv.eventDate||(cv.activatedAt?cv.activatedAt.split('T')[0]:'');
    var _todayStr2=new Date().toISOString().split('T')[0];
    var _isWalletExpired=(cv.expiresAt&&new Date(cv.expiresAt)<new Date())||(_cvDate2&&_cvDate2<_todayStr2);
    if(_isWalletExpired){
      var expDiv=document.createElement('div');
      expDiv.style.cssText='text-align:center;padding:40px 20px;color:var(--muted);';
      expDiv.innerHTML='<div style="font-size:44px;margin-bottom:12px;">⏰</div>'
        +'<div style="font-size:16px;font-weight:800;color:#EF4444;margin-bottom:8px;">Wallet Expired</div>'
        +'<div style="font-size:13px;">This cover has ended. Balance has been reset.</div>';
      inner.appendChild(expDiv);return;
    }

    // TABLE BOOKING: Lock menu until captain marks "Guest Arrived"
    if(cv.isTableBooking&&!cv.actualArrivalTime){
      var waitDiv=document.createElement('div');
      waitDiv.style.cssText='padding:0;';
      // QR code
      var qrWait=document.createElement('div');
      qrWait.style.cssText='background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px 16px;margin-bottom:16px;text-align:center;';
      var qrWaitWrap=document.createElement('div');qrWaitWrap.id='wallet-qr-wait';
      qrWaitWrap.style.cssText='width:140px;height:140px;margin:0 auto 12px;background:#0C0C18;border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden;';
      qrWait.appendChild(qrWaitWrap);
      qrWait.innerHTML+='<div style="font-size:13px;font-weight:800;color:var(--text);margin-bottom:4px;">Your Reservation QR</div>'
        +'<div style="font-size:11px;color:var(--muted);">Show this to your captain on arrival</div>'
        +'<div style="font-family:monospace;font-size:14px;color:var(--gold);margin-top:8px;letter-spacing:2px;">'+sanitize(cv.ref||cv.bookingId||'')+'</div>';
      waitDiv.appendChild(qrWait);
      generateLocalQR('wallet-qr-wait','https://hodclub.in/?verify='+encodeURIComponent(cv.ref||cv.bookingId||cv.id||''));
      // Waiting message
      var waitMsg=document.createElement('div');
      waitMsg.style.cssText='background:rgba(242,199,68,.06);border:1.5px solid rgba(242,199,68,.25);border-radius:16px;padding:24px 20px;text-align:center;margin-bottom:16px;';
      waitMsg.innerHTML='<div style="font-size:40px;margin-bottom:12px;">🪑</div>'
        +'<div style="font-size:18px;font-weight:900;color:var(--gold);margin-bottom:8px;">We\'re preparing your table!</div>'
        +(cv.tableId?'<div style="font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:16px;">Your table <strong style="color:var(--text);">'+sanitize(cv.tableId)+'</strong>'+(cv.floorLabel?' on <strong style="color:var(--text);">'+sanitize(cv.floorLabel)+'</strong>':'')+' is being set up for you.</div>':'<div style="font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:16px;">Your table is being set up. Show your reservation QR to your captain on arrival.</div>')
        +'<div style="display:grid;grid-template-columns:'+(cv.date?'1fr 1fr 1fr':'1fr 1fr')+';gap:10px;margin-bottom:16px;">'
        +(cv.date?'<div style="background:rgba(255,255,255,.03);border-radius:10px;padding:12px;"><div style="font-size:10px;color:var(--muted);margin-bottom:4px;">Date</div><div style="font-size:13px;font-weight:800;color:var(--text);">'+sanitize(cv.date)+'</div></div>':'')
        +'<div style="background:rgba(255,255,255,.03);border-radius:10px;padding:12px;"><div style="font-size:10px;color:var(--muted);margin-bottom:4px;">Arrival</div><div style="font-size:13px;font-weight:800;color:var(--text);">'+sanitize(cv.arrivalTime||'—')+'</div></div>'
        +'<div style="background:rgba(255,255,255,.03);border-radius:10px;padding:12px;"><div style="font-size:10px;color:var(--muted);margin-bottom:4px;">Guests</div><div style="font-size:13px;font-weight:800;color:var(--text);">'+(cv.partySize||0)+'</div></div>'
        +'</div>'
        +'<div style="background:rgba(0,196,255,.06);border:1px solid rgba(0,196,255,.2);border-radius:10px;padding:12px 16px;font-size:12px;color:rgba(0,196,255,.8);line-height:1.6;">ℹ️ The menu will unlock once you arrive and your captain confirms your presence. You\'ll be able to browse and pre-order right from your phone!</div>';
      waitDiv.appendChild(waitMsg);
      inner.appendChild(waitDiv);
      return;
    }