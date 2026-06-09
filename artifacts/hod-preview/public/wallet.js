// HOD Wallet Module — lazy-loaded from index-optimized.html
// Contains: renderWalletPage, renderWalletContent, renderCustomerWallet, renderTopUp
// and all nested helpers (~228KB extracted from main file)
(function(){
"use strict";

function renderWalletPage(bookingRef){
  var wrap=document.createElement('div');
  wrap.className='hod-wallet-v2';
  wrap.style.cssText='min-height:100vh;background:#F4F4F0;color:#000;font-family:var(--ff);padding-bottom:90px;';

  // ── Inject scoped Digitory-style theme (red+yellow+black). Re-themes the
  //    entire wallet page in one place via CSS-var overrides + targeted
  //    overrides for the most common gold/dark inline styles. Scoped to
  //    .hod-wallet-v2 so the public site's gold theme is untouched.
  if(!document.getElementById('hod-wallet-v2-css')){
    var st=document.createElement('style');st.id='hod-wallet-v2-css';
    st.textContent=
      '.hod-wallet-v2{--pink:#FF90E8;--text:#000000;--muted:#3D3D3D;--card:#FFFFFF;--surface:#F4F4F0;--border:2px solid #000;--red:#FF5733;--red-deep:#CC4422;}'
      // Lift hardcoded dark-blue panels (#fff etc.) and rgba(0,0,0,.03) into proper Digitory blacks
      +'.hod-wallet-v2 input,.hod-wallet-v2 button,.hod-wallet-v2 select,.hod-wallet-v2 textarea{font-family:var(--ff);}'
      +'.hod-wallet-v2 input::placeholder{color:#777;}'
      // QR wrap → white card for crisp scan
      +'.hod-wallet-v2 #wallet-qr-wrap,.hod-wallet-v2 #wallet-qr-wait,.hod-wallet-v2 #conf-qr-wrap{background:#fff !important;width:180px !important;height:180px !important;border:6px solid #fff !important;border-radius:14px !important;box-shadow:0 4px 22px rgba(242,199,68,.18);}'
      // Item row dividers — thin red dotted (Digitory)
      +'.hod-wallet-v2 .wv-row{background:#fff !important;border:2px solid #000 !important;border-radius:12px !important;padding:14px 16px !important;margin-bottom:10px !important;}'
      // ADD button — bold red with yellow text
      +'.hod-wallet-v2 .wv-add{padding:9px 22px !important;border-radius:10px !important;background:#000000 !important;border:2px solid #000 !important;color:#FF90E8 !important;font-size:13px !important;font-weight:900 !important;letter-spacing:.5px;text-transform:uppercase;cursor:pointer;font-family:var(--ff);box-shadow:0 2px 10px rgba(184,50,39,.35);transition:transform .15s,box-shadow .15s;}'
      +'.hod-wallet-v2 .wv-add:active{transform:scale(.96);}'
      +'.hod-wallet-v2 .wv-add:hover{background:#FF90E8 !important;color:#000000 !important;border-color:#FF90E8 !important;}'
      // Qty stepper buttons
      +'.hod-wallet-v2 .wv-qbtn{width:32px !important;height:32px !important;border-radius:8px !important;background:#F4F4F0 !important;border:2px solid #000 !important;color:#000 !important;font-size:16px !important;font-weight:900;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:var(--ff);}'
      +'.hod-wallet-v2 .wv-qbtn:hover{background:#000000 !important;}'
      +'.hod-wallet-v2 .wv-qty{font-family:var(--ff);font-size:15px;font-weight:900;color:#000;min-width:22px;text-align:center;}'
      // Category accordion header — bold black panel with yellow underline
      +'.hod-wallet-v2 .wv-cat{background:#fff !important;border:2px solid #000 !important;border-left:4px solid #000000 !important;border-radius:8px !important;padding:14px 16px !important;cursor:pointer;}'
      +'.hod-wallet-v2 .wv-cat .wv-cat-name{font-size:13px !important;font-weight:900 !important;color:#000 !important;letter-spacing:1.6px !important;text-transform:uppercase;}'
      +'.hod-wallet-v2 .wv-cat .wv-cat-count{font-size:11px;color:#6B6B6B;font-weight:700;letter-spacing:.5px;}'
      // Tab buttons — yellow solid active, deep-red outlined inactive
      +'.hod-wallet-v2 .wv-tab{flex:1;padding:18px 8px !important;border-radius:12px !important;font-size:13px !important;font-weight:900 !important;letter-spacing:1.4px;text-transform:uppercase;cursor:pointer;font-family:var(--ff);border:2px solid !important;transition:all .15s;}'
      +'.hod-wallet-v2 .wv-tab.on{background:#FF90E8 !important;border-color:#FF90E8 !important;color:#000000 !important;box-shadow:0 4px 16px rgba(242,199,68,.3);}'
      +'.hod-wallet-v2 .wv-tab.off{background:transparent !important;border-color:#000000 !important;color:#000 !important;}'
      +'.hod-wallet-v2 .wv-tab.off:hover{background:rgba(184,50,39,.18) !important;}'
      // Sticky bottom View Cart bar — Digitory red
      +'.hod-wallet-v2 .wv-stickycart{position:fixed;left:0;right:0;bottom:0;z-index:200;background:#000000;color:#FF90E8;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;font-family:var(--ff);font-weight:900;font-size:15px;letter-spacing:.4px;box-shadow:0 -8px 24px rgba(0,0,0,.5);cursor:pointer;}'
      +'.hod-wallet-v2 .wv-stickycart .wv-sc-amt{font-family:var(--ff);font-size:20px;color:#fff;}'
      // Search input — yellow outline on black
      +'.hod-wallet-v2 .wv-search{width:100%;padding:14px 16px !important;border-radius:12px !important;background:#fff !important;border:2px solid #000 !important;color:#000 !important;font-size:14px !important;font-weight:600;font-family:var(--ff);outline:none;box-sizing:border-box;letter-spacing:.3px;}'
      +'.hod-wallet-v2 .wv-search:focus{border-color:#FF90E8 !important;box-shadow:0 0 0 3px rgba(242,199,68,.12);}'
      // Header strip
      +'.hod-wallet-v2 .wv-hdr{background:#000 !important;border-bottom:2px solid #000000 !important;padding:14px 18px !important;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;}'
      +'.hod-wallet-v2 .wv-hdr-brand{font-family:var(--ff);font-size:24px;font-weight:900;color:#000;letter-spacing:3px;}'
      +'.hod-wallet-v2 .wv-hdr-pill{display:inline-block;padding:7px 14px;border-radius:999px;background:#000;color:#fff;font-size:11px;font-weight:900;letter-spacing:1.2px;text-transform:uppercase;border:2px solid #000;cursor:pointer;font-family:var(--ff);}'
      // Wallet hero card — red-to-black with yellow balance
      +'.hod-wallet-v2 .wv-wcard{background:#FFFFFF !important;border:1.5px solid #FF90E8 !important;border-radius:18px !important;padding:24px !important;margin-bottom:18px;color:#000;box-shadow:0 8px 32px rgba(184,50,39,.25);}'
      +'.hod-wallet-v2 .wv-wcard .wv-bal{font-family:var(--ff);font-size:44px;font-weight:900;color:#000;line-height:1;letter-spacing:-1px;}'
      +'.hod-wallet-v2 .wv-wcard .wv-bal.zero{color:#000;opacity:.6;}'
      // Place order primary button — yellow solid
      +'.hod-wallet-v2 .wv-place{width:100%;padding:18px !important;border-radius:14px !important;background:#FF90E8 !important;border:2px solid #FF90E8 !important;color:#000000 !important;font-size:15px !important;font-weight:900 !important;letter-spacing:1.2px !important;text-transform:uppercase;cursor:pointer;font-family:var(--ff);box-shadow:0 6px 22px rgba(242,199,68,.32);}'
      +'.hod-wallet-v2 .wv-place:disabled,.hod-wallet-v2 .wv-place[style*="opacity:.45"]{opacity:.4;}'
      // Veg dot crisp
      +'.hod-wallet-v2 .wv-vegdot{width:11px !important;height:11px !important;border-radius:2px !important;border:1.5px solid currentColor;display:inline-flex;align-items:center;justify-content:center;margin-right:8px;}'
      +'.hod-wallet-v2 .wv-vegdot::after{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;display:block;}'
      // Force gold→yellow for any remaining #FF90E8 references inside QR-bg circles etc.
      +'.hod-wallet-v2{color-scheme:light;}'
      // ── DIGITORY V3 ADDITIONS ─────────────────────────
      // Full-bleed deep red header strip (replaces black wv-hdr style)
      +'.hod-wallet-v2 .wv-hdr2{background:#fff !important;color:#000;border-bottom:2px solid #000 !important;padding:14px 18px !important;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;}'
      +'.hod-wallet-v2 .wv-hdr2 .wv-hd2-brand{font-size:13px;font-weight:900;letter-spacing:1.4px;text-transform:uppercase;line-height:1.2;color:#000;}'
      +'.hod-wallet-v2 .wv-hdr2 .wv-hd2-otp{font-size:12px;font-weight:700;color:#3D3D3D;letter-spacing:.4px;margin-top:2px;font-family:var(--ff);}'
      +'.hod-wallet-v2 .wv-hdr2 .wv-hd2-otp b{color:#000;letter-spacing:1.5px;font-weight:900;}'
      +'.hod-wallet-v2 .wv-hdr2 .wv-hd2-call{display:flex;align-items:center;gap:8px;color:#000;font-size:12px;font-weight:700;letter-spacing:.4px;cursor:pointer;background:transparent;border:2px solid #000;font-family:var(--ff);}'
      +'.hod-wallet-v2 .wv-hdr2 .wv-hd2-avatar{width:26px;height:26px;border-radius:50%;background:#FF90E8;color:#000000;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;}'
      // 4-tab solid rectangles like Digitory FOOD/LIQUOR/NAB/SMOKE
      +'.hod-wallet-v2 .wv-tab4row{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:14px;}'
      +'.hod-wallet-v2 .wv-tab4{padding:22px 6px;border-radius:8px;font-size:12px;font-weight:900;letter-spacing:1.6px;text-transform:uppercase;cursor:pointer;font-family:var(--ff);border:2px solid #000;text-align:center;transition:all .12s;color:#000;background:#fff;line-height:1.1;box-shadow:0 1px 4px rgba(0,0,0,.15);}'
      +'.hod-wallet-v2 .wv-tab4.on{background:#FF90E8 !important;color:#000000 !important;font-weight:900;box-shadow:0 4px 14px rgba(242,199,68,.32);}'
      +'.hod-wallet-v2 .wv-tab4:active{transform:scale(.97);}'
      // Filters bar (deep red row above tabs)
      +'.hod-wallet-v2 .wv-filters{background:#F2C744;color:#000;border:2px solid #000;padding:13px 16px;border-radius:6px;display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;cursor:pointer;font-size:13px;font-weight:700;letter-spacing:.6px;text-transform:none;}'
      +'.hod-wallet-v2 .wv-filters .wv-fl-arrow{font-size:11px;opacity:.85;transition:transform .15s;}'
      +'.hod-wallet-v2 .wv-filters.open .wv-fl-arrow{transform:rotate(180deg);}'
      +'.hod-wallet-v2 .wv-filters-panel{display:none;background:#fff;border:2px solid #000;border-radius:6px;padding:12px 14px;margin-bottom:10px;gap:8px;flex-wrap:wrap;}'
      +'.hod-wallet-v2 .wv-filters-panel.open{display:flex;}'
      +'.hod-wallet-v2 .wv-fchip{padding:8px 14px;border-radius:999px;background:#F4F4F0;border:2px solid #000;color:#000;font-size:12px;font-weight:700;letter-spacing:.4px;cursor:pointer;font-family:var(--ff);text-transform:uppercase;}'
      +'.hod-wallet-v2 .wv-fchip.on{background:#FF90E8;color:#000000;border-color:#FF90E8;}'
      // Sub-category chip row (wrapped)
      +'.hod-wallet-v2 .wv-subrow{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-bottom:18px;padding:0 4px;}'
      +'.hod-wallet-v2 .wv-subchip{padding:7px 12px;border-radius:6px;background:transparent;border:2px solid #000;color:rgba(0,0,0,.85);font-size:11px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;cursor:pointer;font-family:var(--ff);transition:all .12s;}'
      +'.hod-wallet-v2 .wv-subchip:hover{color:#FF90E8;border-color:#FF90E8;}'
      +'.hod-wallet-v2 .wv-subchip.on{border-color:#000;color:#000;background:#FF90E8;box-shadow:0 0 0 1px #000;}'
      // Section title above item list (e.g. "MANGO MANIA")
      +'.hod-wallet-v2 .wv-sectiontitle{font-family:var(--ff);font-size:24px;font-weight:900;color:#000;letter-spacing:1.2px;text-transform:uppercase;margin:18px 4px 14px;}'
      // Bottom fixed View Cart footer (red strip)
      +'.hod-wallet-v2 .wv-cartfooter{position:fixed;left:0;right:0;bottom:0;z-index:200;background:#000000;padding:0;font-family:var(--ff);box-shadow:0 -8px 24px rgba(0,0,0,.5);display:none;}'
      +'.hod-wallet-v2 .wv-cartfooter.show{display:block;}'
      +'.hod-wallet-v2 .wv-cartfooter .wv-cf-tax{text-align:center;background:#000000;color:rgba(245,241,232,.55);font-size:11px;padding:7px 12px;letter-spacing:.4px;font-style:italic;}'
      +'.hod-wallet-v2 .wv-cartfooter .wv-cf-btn{width:100%;padding:16px;background:#000000;color:#FF90E8;font-size:15px;font-weight:900;letter-spacing:1.4px;text-transform:uppercase;border:2px solid #000;cursor:pointer;font-family:var(--ff);display:flex;align-items:center;justify-content:center;gap:10px;}'
      +'.hod-wallet-v2 .wv-cartfooter .wv-cf-btn .wv-cf-amt{background:#000000;color:#FF90E8;padding:5px 10px;border-radius:6px;font-family:var(--ff);font-size:14px;font-weight:900;letter-spacing:.5px;}'
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
    // 2026-05-13 (Khushi spec) — "Call Waiter" no longer dials a hardcoded
    // phone (the old tel:+918882222900 went to a number nobody at HOD owns
    // any more). It now writes a `waiterCalls/{auto}` doc to Firestore;
    // CaptainMode + BarMode subscribe live, beep, and show a red banner
    // with the table id + an Acknowledge button. Wiring is done below in
    // renderWalletContent() once `cv` is known. The button starts disabled
    // and gets enabled the moment the wallet finishes loading.
    +'<button class="wv-hd2-call" id="wv-hd2-call-btn" type="button" disabled style="opacity:.55;cursor:wait;">'
      +'<span id="wv-hd2-call-label">Call Waiter</span><span class="wv-hd2-avatar">&#9742;</span>'
    +'</button>';
  wrap.appendChild(hdr);

  var inner=document.createElement('div');
  inner.style.cssText='padding:20px;max-width:480px;margin:0 auto;';
  wrap.appendChild(inner);

  // Loading state
  var loadDiv=document.createElement('div');
  loadDiv.style.cssText='text-align:center;padding:60px 20px;color:#3D3D3D;';
  loadDiv.innerHTML='<div style="border:2px solid rgba(242,199,68,.2);border-top-color:#000;border-radius:50%;width:28px;height:28px;animation:spin .7s linear infinite;margin:0 auto 14px;"></div>Loading your wallet...';
  inner.appendChild(loadDiv);

  // Cart state
  var cart={};
  var cartTotal=0;

  // Inclusive grand total (food+drink+SC+GST). Customer sees ONLY this number — never the breakdown.
  function getCartTotal(){return hodComputeBreakdown(Object.values(cart)).grandTotal;}

  // 🆕 2026-06-08 (Khushi) — SHARED per-round location badge. Bar self-orders
  // carry a 'bar' source ('customer_self_order_bar' / 'recharge_at_bar'); table
  // self-orders carry 'customer_self_order'. Legacy rounds with no source get NO
  // badge (never a wrong label). Used by BOTH the YOUR TAB list and the VIEW BILL
  // modal so EVERY round clearly shows where it was placed, no matter the mode.
  function hodRoundLocBadge(r){
    var s=String((r&&r.source)||'').toLowerCase();
    if(s.indexOf('bar')!==-1) return '<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:800;color:#7B2FBE;background:rgba(123,47,190,.12);border:1px solid rgba(123,47,190,.35);padding:2px 8px;border-radius:10px;letter-spacing:.3px;white-space:nowrap;">🍸 Redeemed at bar</span>';
    if(s==='customer_self_order') return '<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:800;color:#a85800;background:rgba(168,88,0,.10);border:1px solid rgba(168,88,0,.30);padding:2px 8px;border-radius:10px;letter-spacing:.3px;white-space:nowrap;">🍽️ At your table</span>';
    return '';
  }

  function renderWalletContent(cv){
    inner.innerHTML='';
    var bal=cv.coverBalance||0;
    var activated=cv.coverActivated||0;
    var used=cv.coverUsed||0;
    var name=cv.name||'Guest';

    // 🔴 2026-05-13 (Khushi) — UNIFIED top banner. Covers / guestlist /
    // entry-only / group bookings now share the same visual treatment
    // as table bookings (slim gold-bordered card, info chips). The only
    // functional difference: covers carry a real wallet balance shown
    // as a chip; tables show ₹0 until the captain settles. Replaces
    // the old red gradient wv-wcard for covers.
    var _isActivatedTop = !!cv.checkedIn || (cv.coverActivated||0) > 0;
    if(cv.isTableBooking){
      var tbBanner=document.createElement('div');
      tbBanner.style.cssText='background:rgba(242,199,68,.08);border:2px solid #000;border-radius:8px;padding:14px 16px;margin-bottom:14px;';
      tbBanner.innerHTML='<div style="font-size:11px;font-weight:800;color:#000;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">🪑 Table Reservation · Pre-Order Menu</div>'
        +'<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:#3D3D3D;">'
        +'<span>📍 <b style="color:#000;">'+sanitize(cv.tableId||'')+'</b> · '+sanitize(cv.floorLabel||'')+'</span>'
        +'<span>📅 <b style="color:#000;">'+sanitize(cv.date||'')+'</b></span>'
        +'<span>🕐 <b style="color:#000;">'+sanitize(cv.arrivalTime||'')+'</b></span>'
        +'<span>👥 <b style="color:#000;">'+sanitize(String(cv.partySize||0))+'</b> guests</span>'
        +'</div>'
        +(bal<=0?'<div style="margin-top:8px;font-size:12px;font-weight:700;color:#000;background:#FFE0F6;border:2px solid #000;border-radius:8px;padding:7px 10px;box-shadow:2px 2px 0 #000;">💰 Pre-order below — pay via cash, card or UPI at your table.</div>':'')
        ;
      inner.appendChild(tbBanner);
    } else {
      // ── Cover / Guestlist / Entry-Only / Group banner — same chrome
      // as table banner above for visual parity. Header line varies
      // based on type (entry-only is door-only, others redeem against
      // the wallet balance via bartender scan).
      var _coverHeader = 'COVER · ' + sanitize(cv.eventTitle || 'HOD · Tonight');
      var _balChipBg = bal > 0 ? 'rgba(34,197,94,.12)' : 'rgba(0,0,0,.04)';
      var _balChipBorder = bal > 0 ? 'rgba(34,197,94,.4)' : 'rgba(0,0,0,.12)';
      var _balChipColor = bal > 0 ? '#22C55E' : 'rgba(255,255,255,.55)';
      var coverBanner = document.createElement('div');
      coverBanner.style.cssText='background:#fff;border:2px solid #000;border-bottom:1px dashed rgba(0,0,0,.1);border-radius:8px 8px 0 0;padding:14px 16px;margin-bottom:0;';
      // 🔴 2026-05-13 v2 (Khushi) — small balance chip removed; balance now
      // displayed prominently in its own BALANCE card above the QR (below).
      coverBanner.innerHTML='<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px;">'
        +'<div style="font-size:11px;font-weight:800;color:#000;letter-spacing:1px;text-transform:uppercase;">'+_coverHeader+'</div>'
        +((cv.date||cv.eventDate)?'<div style="flex-shrink:0;font-size:10px;font-weight:800;color:#000;background:#FF90E8;border:2px solid #000;border-radius:6px;padding:3px 8px;letter-spacing:.5px;box-shadow:2px 2px 0 #000;white-space:nowrap;">'+sanitize(cv.date||cv.eventDate)+'</div>':'')
        +'</div>'
        +'<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:13px;color:#3D3D3D;">'
        +  '<span><b style="color:#000;font-size:14px;">'+sanitize(name)+'</b></span>'
        // 🆕 2026-06-08 v3.218 (Khushi) — the "₹X used / ₹Y total" cover badge is
        // REMOVED here. It surfaced cv.coverUsed which could drift from the real
        // bill (showed 1680 while the bar bill + VIEW BILL were 1650), confusing
        // the guest with two different totals. The wallet balance card below + the
        // RUNNING TAB (now anchored to the computed breakdown) are the single source.
        +'</div>'
        +(!_isActivatedTop?'<div style="margin-top:8px;font-size:11px;color:#000;background:#F4F4F0;border:2px solid #000;border-radius:8px;padding:6px 10px;box-shadow:2px 2px 0 #000;">⏳ Your cover will be activated at HOD when you arrive.</div>':'');
      inner.appendChild(coverBanner);
    }

    // 🆕 2026-06-07 (Khushi) — TOP "✅ Bill Settled · View Bill" banner REMOVED.
    // It rendered on cv.paymentStatus==='paid', but an online TABLE booking
    // carries paymentStatus:'paid' from the PREPAID COVER deposit while the
    // FOOD TAB is still OPEN — so the banner wrongly announced "Bill Settled"
    // on a live, unsettled table. The customer can still open their full GST
    // invoice any time via the "📄 VIEW BILL" button inside the YOUR TAB card
    // (renderRoundsHistory below), so no bill access is lost by removing this.

    // Expiry check — date-based or expiresAt.
    // 🆕 2026-05-27 v3.65 (Khushi LIVE-NIGHT) — was using calendar UTC date
    // (toISOString) but HOD runs OPERATIONAL NIGHTS noon→noon IST. At 6am IST
    // calendar is already next-day but the event night is still running until
    // noon → fresh entry-only bookings for "tonight" showed "Wallet Expired"
    // because cv.date="2026-05-26" < todayUTC="2026-05-27". Now mirror POS
    // getOperationalNightStr(): before noon IST → use yesterday's local date.
    // Second guard: NEVER show expired for a wallet that's never been
    // activated AND has no orders (entry-only pre-check-in case) — the screen
    // should fall through to the door/check-in waiting state instead.
    var _cvDate2=cv.date||cv.eventDate||(cv.activatedAt?cv.activatedAt.split('T')[0]:'');
    var _opNow=new Date();
    var _opAnchor=new Date(_opNow);
    if(_opNow.getHours()<12){_opAnchor.setDate(_opAnchor.getDate()-1);}
    var _todayStr2=_opAnchor.getFullYear()+'-'+String(_opAnchor.getMonth()+1).padStart(2,'0')+'-'+String(_opAnchor.getDate()).padStart(2,'0');
    var _hasActivity=Number(cv.coverActivated||0)>0||Number(cv.coverBalance||0)>0||(Array.isArray(cv.tabRounds)&&cv.tabRounds.length>0)||cv.paymentStatus==='paid';
    var _isWalletExpired=_hasActivity&&((cv.expiresAt&&new Date(cv.expiresAt)<new Date())||(_cvDate2&&_cvDate2<_todayStr2));
    if(_isWalletExpired){
      var expDiv=document.createElement('div');
      expDiv.style.cssText='text-align:center;padding:40px 20px;color:#3D3D3D;';
      expDiv.innerHTML='<div style="font-size:44px;margin-bottom:12px;">⏰</div>'
        +'<div style="font-size:16px;font-weight:800;color:#FF5733;margin-bottom:8px;">Wallet Expired</div>'
        +'<div style="font-size:13px;">This cover has ended. Balance has been reset.</div>';
      inner.appendChild(expDiv);return;
    }

    // TABLE BOOKING: Lock menu until captain marks "Guest Arrived"
    if(cv.isTableBooking&&!cv.actualArrivalTime){
      var waitDiv=document.createElement('div');
      waitDiv.style.cssText='padding:0;';
      // QR code
      var qrWait=document.createElement('div');
      qrWait.style.cssText='background:#fff;border:2px solid #000;border-radius:8px;padding:20px 16px;margin-bottom:16px;text-align:center;box-shadow:3px 3px 0 #000;';
      var qrWaitWrap=document.createElement('div');qrWaitWrap.id='wallet-qr-wait';
      qrWaitWrap.style.cssText='width:140px;height:140px;margin:0 auto 12px;background:#fff;border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden;';
      qrWait.appendChild(qrWaitWrap);
      qrWait.innerHTML+='<div style="font-size:13px;font-weight:800;color:#000;margin-bottom:4px;">Your Reservation QR</div>'
        +'<div style="font-size:11px;color:#3D3D3D;">Show this to your captain on arrival</div>'
        +'<div style="font-family:monospace;font-size:14px;color:#000;margin-top:8px;letter-spacing:2px;">'+sanitize(cv.ref||cv.bookingId||'')+'</div>';
      waitDiv.appendChild(qrWait);
      generateLocalQR('wallet-qr-wait','https://hodclub.in/?verify='+encodeURIComponent(cv.ref||cv.bookingId||cv.id||''));
      // Waiting message
      var waitMsg=document.createElement('div');
      waitMsg.style.cssText='background:#fff;border:2px solid #000;border-radius:8px;padding:24px 20px;text-align:center;margin-bottom:16px;box-shadow:3px 3px 0 #000;';
      waitMsg.innerHTML='<div style="font-size:40px;margin-bottom:12px;">🪑</div>'
        +'<div style="font-size:18px;font-weight:900;color:#000;margin-bottom:8px;">We\'re preparing your table!</div>'
        +(cv.tableId?'<div style="font-size:13px;color:#3D3D3D;line-height:1.7;margin-bottom:16px;">Your table <strong style="color:#000;">'+sanitize(cv.tableId)+'</strong>'+(cv.floorLabel?' on <strong style="color:#000;">'+sanitize(cv.floorLabel)+'</strong>':'')+' is being set up for you.</div>':'<div style="font-size:13px;color:#3D3D3D;line-height:1.7;margin-bottom:16px;">Your table is being set up. Show your reservation QR to your captain on arrival.</div>')
        +'<div style="display:grid;grid-template-columns:'+(cv.date?'1fr 1fr 1fr':'1fr 1fr')+';gap:10px;margin-bottom:16px;">'
        +(cv.date?'<div style="background:rgba(0,0,0,.03);border-radius:8px;padding:12px;"><div style="font-size:10px;color:#3D3D3D;margin-bottom:4px;">Date</div><div style="font-size:13px;font-weight:800;color:#000;">'+sanitize(cv.date)+'</div></div>':'')
        +'<div style="background:rgba(0,0,0,.03);border-radius:8px;padding:12px;"><div style="font-size:10px;color:#3D3D3D;margin-bottom:4px;">Arrival</div><div style="font-size:13px;font-weight:800;color:#000;">'+sanitize(cv.arrivalTime||'—')+'</div></div>'
        +'<div style="background:rgba(0,0,0,.03);border-radius:8px;padding:12px;"><div style="font-size:10px;color:#3D3D3D;margin-bottom:4px;">Guests</div><div style="font-size:13px;font-weight:800;color:#000;">'+(cv.partySize||0)+'</div></div>'
        +'</div>'
        +'<div style="background:rgba(35,160,148,.10);border:2px solid #000;border-radius:8px;padding:12px 16px;font-size:12px;font-weight:600;color:#000;line-height:1.6;box-shadow:3px 3px 0 #23A094;">ℹ️ The menu will unlock once you arrive and your captain confirms your presence. You\'ll be able to browse and pre-order right from your phone!</div>';
      waitDiv.appendChild(waitMsg);
      inner.appendChild(waitDiv);
      return;
    }
    // Table bookings start with 0 balance — show menu anyway
    if(bal<=0&&!cv.isTableBooking){
      // Show recharge banner — menu continues below
      var emptyBanner=document.createElement('div');
      // 🔴 2026-05-13 v2 (Khushi) — recolor purple → red/yellow/white theme.
      emptyBanner.style.cssText='background:#FFE0F6;border:2px solid #000;border-radius:8px;padding:20px;margin-bottom:16px;text-align:center;box-shadow:3px 3px 0 #000;';
      emptyBanner.innerHTML='<div style="font-size:28px;margin-bottom:8px;">⚡</div>'
        +'<div style="font-size:15px;font-weight:900;color:#000;margin-bottom:6px;">Load your wallet to start ordering</div>'
        +'<div style="font-size:12px;color:#000;line-height:1.6;margin-bottom:14px;">Enter an amount below and pay online, or show your QR above to the bartender — they can recharge for you too.</div>';
      var _rcAmt=0;
      // ── 2026-05-11 (Khushi feature) — CUSTOM AMOUNT INPUT on empty-wallet banner.
      // 🆕 2026-06-03 v3.205 (Khushi) — quick-amount chips (₹500/999/1499/1999)
      // REMOVED entirely, and the input's inner 2px border + number-spinner box
      // removed (the "box inside the amount box" looked bad). Now ONE clean
      // amount field. Min ₹1, max ₹50,000; blank/invalid → Pay button blocks
      // (no ₹0 send). type=text + inputmode=numeric kills the browser spinner.
      var _emptyCustomWrap=document.createElement('div');
      _emptyCustomWrap.style.cssText='margin:4px 0 10px;';
      _emptyCustomWrap.innerHTML='<div style="font-size:10px;font-weight:700;color:#3D3D3D;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;text-align:center;">Enter recharge amount</div>';
      var _emptyCustomRow=document.createElement('div');
      _emptyCustomRow.style.cssText='display:flex;align-items:center;gap:8px;padding:12px 14px;border-radius:8px;border:2px solid #000;background:#fff;';
      _emptyCustomRow.innerHTML='<span style="font-family:var(--ff);font-size:16px;font-weight:900;color:#000;">₹</span>';
      var _emptyCustomInput=document.createElement('input');
      _emptyCustomInput.type='text';_emptyCustomInput.inputMode='numeric';_emptyCustomInput.setAttribute('pattern','[0-9]*');
      _emptyCustomInput.placeholder='Enter amount';
      _emptyCustomInput.style.cssText='flex:1;background:transparent;border:none;outline:none;color:#000;font-family:var(--ff);font-size:16px;font-weight:900;width:100%;';
      _emptyCustomInput.oninput=function(){
        var v=parseInt((_emptyCustomInput.value||'').replace(/[^0-9]/g,''),10);
        if(isNaN(v)||v<1){_emptyCustomRow.style.borderColor='#FF5733';_rcAmt=0;return;}
        if(v>50000){v=50000;}
        _emptyCustomInput.value=String(v);
        _emptyCustomRow.style.borderColor='#000';
        _rcAmt=v;
      };
      _emptyCustomRow.appendChild(_emptyCustomInput);
      _emptyCustomWrap.appendChild(_emptyCustomRow);
      emptyBanner.appendChild(_emptyCustomWrap);
      var rcPayBtn=document.createElement('button');
      rcPayBtn.style.cssText='width:100%;padding:12px;border-radius:8px;background:#FF90E8;border:2px solid #000;color:#000000;font-size:14px;font-weight:900;cursor:pointer;font-family:var(--ff);letter-spacing:.4px;';
      rcPayBtn.textContent='💳 Pay & Recharge';
      rcPayBtn.onclick=function(){
        if(!_rcAmt){showToast('Select an amount first','err',2000);return;}
        rcPayBtn.disabled=true;rcPayBtn.textContent='Opening payment...';
        // V4 2026-05-11 — server-verified recharge (Razorpay signature check
        // before crediting wallet). Replaces direct Firestore client write.
        var _coverRef3=(cv.bookingId||cv.ref||'').replace(/[^a-zA-Z0-9_-]/g,'_');
        hodPayAndCredit({
          amount:_rcAmt, coverRef:_coverRef3, kind:'topup',
          name:cv.name||'', phone:cv.phone||'',
          description:'Wallet Recharge ₹'+_rcAmt, payBtn:rcPayBtn,
          onSuccess:function(newBalance){
            showToast('✅ Recharged ₹'+_rcAmt+'! Wallet updated.','success',4000);
          },
          onError:function(msg){
            rcPayBtn.disabled=false;rcPayBtn.textContent='💳 Pay & Recharge';
            showToast('⚠️ '+msg,'err',10000);
          },
          onClose:function(){rcPayBtn.disabled=false;rcPayBtn.textContent='💳 Pay & Recharge';}
        });
      };
      emptyBanner.appendChild(rcPayBtn);
      // 🆕 2026-06-03 v3.205 (Khushi) — DO NOT append the recharge card here.
      // It is now placed BELOW the balance + QR (see append after the QR
      // section). Desired order: customer details → balance → scanner →
      // recharge → "recharge above" note. Don't return — menu continues below.
    }

    // 🆕 2026-06-02 (Khushi) — LINKED-TABLE wallet: surface the assigned
    // table PROMINENTLY the moment the wallet opens, so the guest knows they
    // have a table (and can pick table-service vs the bar) BEFORE ordering.
    // Data is already on the cover doc (linkedTableId/linkedFloorLabel) — the
    // same source the post-order "WHERE ARE YOU?" popup reads. Falls back to
    // tableId/floorLabel for pure table bookings; renders nothing if no table.
    var _walTblId = cv.linkedTableId || cv.tableId || '';
    var _walTblFloor = cv.linkedFloorLabel || cv.floorLabel || '';
    if(_walTblId){
      var tblCard=document.createElement('div');
      tblCard.style.cssText='background:rgba(16,185,129,.12);border:2px solid #000;border-radius:8px;padding:12px 16px;margin-bottom:12px;display:flex;align-items:center;justify-content:center;gap:12px;box-shadow:3px 3px 0 #23A094;';
      tblCard.innerHTML='<span style="font-size:24px;line-height:1;">\ud83e\ude91</span>'
        +'<div style="text-align:left;">'
        +  '<div style="font-family:var(--ff);font-size:10px;font-weight:800;color:#000;letter-spacing:1.6px;text-transform:uppercase;margin-bottom:2px;">Your Table</div>'
        +  '<div style="font-family:var(--ff);font-size:20px;font-weight:900;color:#000;line-height:1;letter-spacing:.3px;">'+sanitize(_walTblId)+(_walTblFloor?' <span style="color:rgba(0,0,0,.6);font-size:14px;font-weight:700;">\u00b7 '+sanitize(_walTblFloor)+'</span>':'')+'</div>'
        +'</div>';
      inner.appendChild(tblCard);
    }

    // 🔴 2026-05-13 v2 (Khushi) — Big BALANCE block above the QR for
    // covers/guestlist/entry-only/group. Non-cursive tabular numerals,
    // large font, sits centred so the customer (and bartender across
    // the counter) can read it at a glance. Hidden for table bookings.
    // 🔴 2026-05-25 (Khushi LIVE-NIGHT) — TABLE BOOKINGS now also show
    // the balance block ONCE a cover has been activated at the door
    // (covers Khushi's "Chiru late arrival" flow: table booked +
    // ₹1000 cover charged at the door → guest needs to see his ₹1000
    // wallet balance to pre-order). Previously only non-table covers
    // got the balance card. We still hide it for fresh table
    // reservations (activated===0) — those rely on captain-side
    // settlement, no wallet redemption needed.
    var _showBal = (!cv.isTableBooking) || ((cv.coverActivated||0) > 0);
    if(_showBal){
      var balBlock=document.createElement('div');
      var _bbColor = bal > 0 ? '#000' : '#FF5733';
      balBlock.style.cssText='background:#fff;border:2px solid #000;border-top:none;border-bottom:1px dashed rgba(0,0,0,.1);border-radius:0;padding:18px;margin-bottom:0;text-align:center;';
      balBlock.innerHTML='<div style="font-size:10px;font-weight:800;color:#3D3D3D;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">Wallet Balance</div>'
        +'<div style="font-family:var(--ff);font-size:40px;font-weight:900;color:'+_bbColor+';line-height:1;font-variant-numeric:tabular-nums;">\u20b9'+bal.toLocaleString('en-IN')+'</div>';
      inner.appendChild(balBlock);
    }

    // QR code for customer
    var qrSec=document.createElement('div');
    // 2026-05-13 (Khushi spec, round 5) — table guests don't NEED a big QR
    // (the captain just glances at it before scanning). Shrunk the card +
    // QR + text considerably so the menu sits closer to the top.
    var _isTbl=cv.isTableBooking;
    qrSec.style.cssText=_isTbl?'background:#fff;border:2px solid #000;border-radius:8px;padding:14px;margin-bottom:14px;text-align:center;box-shadow:3px 3px 0 #000;':'background:#fff;border:2px solid #000;border-top:none;border-bottom:1px dashed rgba(0,0,0,.1);border-radius:0;padding:18px 16px;margin-bottom:0;text-align:center;';
    var qrWrap=document.createElement('div');qrWrap.id='wallet-qr-wrap';
    var _qrPx=_isTbl?100:140;
    qrWrap.style.cssText='width:'+_qrPx+'px;height:'+_qrPx+'px;margin:0 auto '+(_isTbl?'8px':'14px')+';background:#fff;border-radius:'+(_isTbl?'8px':'14px')+';display:flex;align-items:center;justify-content:center;overflow:hidden;';
    var qrInfo2=document.createElement('div');
    var _isActivated=cv.checkedIn||cv.coverActivated>0;
    var _qrSub=cv.isTableBooking?'Show to your captain to activate orders.':(_isActivated?'Your HOD Wallet':'Show this at the entrance to check in.');
    var _walletNote=cv.isTableBooking?'':(!_isActivated?'<div style="font-size:11px;background:rgba(242,199,68,.08);border:2px solid #000;border-radius:8px;padding:6px 10px;margin-top:8px;color:rgba(242,199,68,.8);">⏳ Your wallet activates when you arrive at HOD</div>':'');
    // 2026-05-13 (Khushi spec) — show the guest's name prominently above the
    // QR card so the captain can verify identity at a glance before scanning.
    var _guestName=sanitize(cv.name||'Guest');
    qrInfo2.innerHTML='<div style="font-family:var(--ff);font-size:'+(_isTbl?'14px':'18px')+';font-weight:900;color:#000;margin-bottom:'+(_isTbl?'4px':'8px')+';letter-spacing:.3px;line-height:1.2;">'+_guestName+'</div>'
      +(_isTbl?'':'<div style="font-size:13px;font-weight:800;color:#000;margin-bottom:4px;">Your HOD QR Code</div>')
      +'<div style="font-size:'+(_isTbl?'10px':'11px')+';color:#3D3D3D;line-height:1.5;">'+_qrSub+'</div>'
      +_walletNote
      +'<div style="font-size:'+(_isTbl?'10px':'11px')+';color:#000;margin-top:'+(_isTbl?'4px':'6px')+';font-family:monospace;letter-spacing:1px;">'+sanitize(cv.ref||cv.bookingId||'')+'</div>';
    qrSec.appendChild(qrWrap);qrSec.appendChild(qrInfo2);inner.appendChild(qrSec);
    generateLocalQR('wallet-qr-wrap','https://hodclub.in/?verify='+encodeURIComponent(cv.ref||cv.bookingId||cv.id||'')+'');

    // 🆕 2026-06-03 v3.205 (Khushi) — RECHARGE card placed HERE, below the
    // balance + QR (order: customer details → balance → scanner → recharge →
    // "recharge above" note in evInfo). emptyBanner is created above only when
    // bal<=0 && !isTableBooking; var-hoisted so it's undefined otherwise.
    if(typeof emptyBanner!=='undefined' && emptyBanner){ inner.appendChild(emptyBanner); }

    // For event tickets — show bartender instruction then the menu below
    if(!cv.isTableBooking){
      var evInfo=document.createElement('div');
      evInfo.style.cssText='background:#FFE0F6;border:2px solid #000;border-top:none;border-radius:0 0 8px 8px;padding:14px 16px;margin-bottom:16px;text-align:center;font-size:12px;color:#000;line-height:1.6;box-shadow:3px 3px 0 #000;';
      if(bal>0){
        // 🔴 2026-05-20 (Khushi) — ONE prominent BOLD "show QR to bartender"
        // message. Previous version repeated the same instruction 3x across
        // QR card subtitle, this evInfo, and the cyan info strip below —
        // confusing for customers. Now this is the SOLE bold callout.
        if(_walTblId && cv.linkedTableRef){
          // 🆕 2026-06-02 (Khushi) — table linked → DON'T presume the bar.
          // Present BOTH ways to order up front so the guest decides; the
          // actual delivery routing is still confirmed in the post-order
          // "WHERE ARE YOU?" popup (which pre-selects this table).
          // ⚠️ Gated on linkedTableRef (not just the id) so we only promise
          // "captain serves you" when the post-order captain-ping can ACTUALLY
          // fire — that path requires linkedTableRef. If a table id exists but
          // no ref, we fall through to the safe bar-only copy (popup also
          // falls back to bartender QR), keeping the message and routing aligned.
          evInfo.innerHTML='<div style="font-size:13px;font-weight:900;color:#000;margin-bottom:8px;letter-spacing:.3px;">ORDERING OPTIONS</div>'
            +'<div style="font-size:11px;color:#3D3D3D;line-height:1.6;text-align:center;max-width:300px;margin:0 auto;">'
            +  '<div style="margin-bottom:6px;"><strong style="color:#000;">At table '+sanitize(_walTblId)+'</strong> — browse menu below, captain serves you.</div>'
            +  '<div><strong style="color:#000;">At the bar</strong> — show QR above to bartender.</div>'
            +'</div>'
            +'<div style="font-size:11px;color:#000;line-height:1.5;margin-top:8px;">Balance <strong style="color:#000;">₹'+((cv.coverActivated||0).toLocaleString('en-IN'))+'</strong> deducts as you order.</div>';
        } else {
        evInfo.innerHTML='<div style="font-size:13px;font-weight:900;color:#000;margin-bottom:6px;letter-spacing:.3px;">SHOW QR TO BARTENDER TO ORDER</div>'
          +'<div style="font-size:11px;color:#000;line-height:1.5;">Balance <strong style="color:#000;">₹'+((cv.coverActivated||0).toLocaleString('en-IN'))+'</strong> deducts as you order.</div>';
        }
      } else {
        evInfo.innerHTML='<div style="font-size:13px;font-weight:900;color:#000;margin-bottom:6px;letter-spacing:.3px;">RECHARGE TO ORDER</div>'
          +'<div style="font-size:11px;color:#000;line-height:1.5;">Recharge above, or ask bartender — they accept cash, UPI or card.</div>';
      }
      inner.appendChild(evInfo);
    }

    // Instructions — 🆕 2026-06-03 v3.205 (Khushi) — the non-table
    // "ℹ️ Browse our menu below — your cover balance will be deducted..." line
    // was REMOVED (redundant with the evInfo callout above). The table-booking
    // pre-order instruction is kept.
    if(cv.isTableBooking){
      var info=document.createElement('div');
      info.style.cssText='background:rgba(35,160,148,.10);border:2px solid #000;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:12px;font-weight:600;color:#000;line-height:1.6;box-shadow:3px 3px 0 #23A094;';
      info.innerHTML='\u2139\ufe0f Browse the menu below, select what you want, and tap <strong>Submit Pre-Order</strong>. Your waiter will scan your QR and activate your order at the table.';
      inner.appendChild(info);
    }

    // Cart summary (sticky) — 2026-05-13 (Khushi spec, round 5):
    // suppressed entirely. The same info now lives in the bottom
    // "Running Tab" footer (renderCartSummary), so showing it at the top
    // too was a duplicate. We keep the element + updateCartBar() function
    // so existing callers keep working — it just stays hidden.
    var cartBar=document.createElement('div');
    cartBar.id='wallet-cart-bar';
    cartBar.style.cssText='display:none !important;';
    inner.appendChild(cartBar);

    function updateCartBar(){
      var total=getCartTotal();
      cartTotal=total;
      cartBar.style.display='none';
      return;
      // (legacy code below intentionally unreachable — kept for diff context)
      if(Object.keys(cart).length===0){cartBar.style.display='none';return;}
      cartBar.style.display='block';
      var over=total>bal;
      var _ci=Object.values(cart);
      var _lines=_ci.map(function(it){return '<div style="display:flex;justify-content:space-between;padding:2px 0;">'+'<span>'+it.qty+'\u00d7 '+sanitize(it.n)+'</span>'+'<span style="color:#000;">\u20b9'+(it.p*it.qty)+'</span></div>';}).join('');
      var _bd=hodComputeBreakdown(_ci);
      var _fmt=function(n){return '\u20b9'+(Math.round(n*100)/100).toLocaleString('en-IN',{minimumFractionDigits:n%1?2:0,maximumFractionDigits:2});};
      var _bdRows='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#3D3D3D;"><span>Sub Total</span><span>'+_fmt(_bd.subtotal)+'</span></div>'
        +'<div style="display:flex;justify-content:space-between;padding:2px 0;color:#3D3D3D;"><span>Service Charge (10%)</span><span>'+_fmt(_bd.serviceCharge)+'</span></div>';
      if(_bd.cgst>0)_bdRows+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#3D3D3D;"><span>CGST (2.5%)</span><span>'+_fmt(_bd.cgst)+'</span></div>'
        +'<div style="display:flex;justify-content:space-between;padding:2px 0;color:#3D3D3D;"><span>SGST (2.5%)</span><span>'+_fmt(_bd.sgst)+'</span></div>';
      if(Math.abs(_bd.roundOff)>=0.01)_bdRows+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#3D3D3D;"><span>Round Off</span><span>'+(_bd.roundOff>=0?'+':'')+_fmt(_bd.roundOff)+'</span></div>';
      cartBar.innerHTML='<div style="padding:8px 4px 4px;">'
        +'<div style="font-size:12px;color:rgba(242,199,68,.9);line-height:1.9;margin-bottom:8px;">'+_lines+'</div>'
        +'<details style="border-top:1px solid rgba(0,0,0,.08);padding-top:6px;margin-bottom:6px;">'
        +'<summary style="display:flex;justify-content:space-between;align-items:center;list-style:none;cursor:pointer;font-size:11px;color:rgba(242,199,68,.7);font-style:italic;">'
        +'<span>Inclusive of all taxes <span style="opacity:.6;font-size:9px;">\u25be view breakdown</span></span>'
        +'<span style="font-size:18px;font-weight:900;color:#000;font-style:normal;">\u20b9'+total.toLocaleString('en-IN')+'</span>'
        +'</summary>'
        +'<div style="font-size:11px;line-height:1.7;padding-top:8px;margin-top:6px;border-top:1px dashed rgba(0,0,0,.06);">'+_bdRows+'</div>'
        +'</details></div>';
    }

    // Menu search (fuzzy, typo-tolerant)
    var menuQuery='';
    function _norm(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
    function _lev(a,b){var m=a.length,n=b.length;if(!m)return n;if(!n)return m;var dp=[];for(var i=0;i<=m;i++)dp.push([i]);for(var j=1;j<=n;j++)dp[0][j]=j;for(var i=1;i<=m;i++)for(var j=1;j<=n;j++){var c=a[i-1]===b[j-1]?0:1;dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+c);}return dp[m][n];}
    function _wordMatch(word,target){
      if(!word)return true;
      if(target.indexOf(word)>=0)return true;
      if(word.length<4)return false;
      var tokens=target.split(' ');
      for(var i=0;i<tokens.length;i++){
        var t=tokens[i];
        if(!t)continue;
        if(t.indexOf(word)>=0)return true;
        var d=_lev(word,t);
        var allow=word.length>=7?2:1;
        if(d<=allow)return true;
      }
      return false;
    }
    function _filterMenu(menuData,q){
      var nq=_norm(q);if(!nq)return menuData;
      var words=nq.split(' ').filter(Boolean);
      var out=[];
      menuData.forEach(function(catObj){
        var hits=catObj.items.filter(function(it){
          var hay=_norm(it.n)+' '+_norm(catObj.cat);
          for(var i=0;i<words.length;i++)if(!_wordMatch(words[i],hay))return false;
          return true;
        });
        if(hits.length)out.push({cat:catObj.cat,items:hits});
      });
      return out;
    }
    function _searchAllMenus(q){
      // Same defensive read as hodGetMenuByTab — never crash on first paint.
      var _FOOD=(window.HOD_FOOD_MENU||(typeof HOD_FOOD_MENU_FALLBACK!=='undefined'?HOD_FOOD_MENU_FALLBACK:[]));
      var _BAR=(window.HOD_BAR_MENU||(typeof HOD_BAR_MENU_FALLBACK!=='undefined'?HOD_BAR_MENU_FALLBACK:[]));
      var f=_filterMenu(_FOOD,q);
      var b=_filterMenu(_BAR,q);
      // Tag categories so user can tell food vs drink in unified view
      var out=[];
      f.forEach(function(c){out.push({cat:'\ud83c\udf7d '+c.cat,items:c.items});});
      b.forEach(function(c){out.push({cat:'\ud83e\udd43 '+c.cat,items:c.items});});
      return out;
    }
    var menuSearchWrap=document.createElement('div');
    menuSearchWrap.style.cssText='margin-bottom:10px;position:relative;';
    var menuSearchInp=document.createElement('input');
    menuSearchInp.type='search';
    menuSearchInp.placeholder='\ud83d\udd0d Search menu — food, drinks, brands…';
    menuSearchInp.className='wv-search';
    menuSearchInp.oninput=function(){
      menuQuery=menuSearchInp.value;
      menuContent.innerHTML='';
      // 🔴 2026-05-13 (Khushi) — search now scoped to ACTIVE TAB only.
      // Old behaviour searched FOOD+LIQUOR together, so "beer" on the
      // LIQUOR tab returned "Beer Chilli Chicken" from food. Customer
      // already picked a tab — respect their intent.
      if(menuQuery.trim()){
        buildMenu(_filterMenu(hodGetMenuByTab(tabState.active),menuQuery));
      } else {
        buildMenu(hodGetMenuByTab(tabState.active));
      }
    };
    menuSearchWrap.appendChild(menuSearchInp);
    inner.appendChild(menuSearchWrap);

    // ── DIGITORY V3: Filters bar (deep red, collapsible)
    var filterState={vegOnly:false};
    var filtersBar=document.createElement('div');
    filtersBar.className='wv-filters';
    filtersBar.innerHTML='<span>Filters &nbsp;<span style="font-size:14px;letter-spacing:0;">\u21C5</span></span><span class="wv-fl-arrow">\u25BE</span>';
    var filtersPanel=document.createElement('div');
    filtersPanel.className='wv-filters-panel';
    var vegChip=document.createElement('button');
    vegChip.className='wv-fchip';
    vegChip.innerHTML='<span class="wv-vegdot" style="color:#00C864;vertical-align:middle;"></span>Veg only';
    vegChip.onclick=function(ev){
      ev.stopPropagation();
      filterState.vegOnly=!filterState.vegOnly;
      vegChip.className='wv-fchip'+(filterState.vegOnly?' on':'');
      menuContent.innerHTML='';buildMenu(currentMenuData());
    };
    filtersPanel.appendChild(vegChip);
    filtersBar.onclick=function(){
      var open=!filtersBar.classList.contains('open');
      filtersBar.classList.toggle('open',open);
      filtersPanel.classList.toggle('open',open);
    };
    inner.appendChild(filtersBar);
    inner.appendChild(filtersPanel);

    // ── DIGITORY V3: 4 hard tabs (FOOD / LIQUOR / NAB / SMOKE)
    // Default: nightlife = LIQUOR, table booking (dining) = FOOD.
    var tabState={active:cv.isTableBooking?'food':'liquor', sub:0};
    var tabBar2=document.createElement('div');
    tabBar2.className='wv-tab4row';
    var tBtns={};
    var TABS=[['food','Food'],['liquor','Liquor'],['nab','NAB'],['smoke','Smoke']];
    TABS.forEach(function(t){
      var btn=document.createElement('button');
      btn.className='wv-tab4'+(t[0]===tabState.active?' on':'');
      btn.textContent=t[1];tBtns[t[0]]=btn;
      btn.onclick=function(){
        tabState.active=t[0];tabState.sub=0;
        TABS.forEach(function(x){tBtns[x[0]].className='wv-tab4'+(x[0]===t[0]?' on':'');});
        menuQuery='';menuSearchInp.value='';
        menuContent.innerHTML='';buildMenu(currentMenuData());
      };
      tabBar2.appendChild(btn);
    });
    inner.appendChild(tabBar2);

    // 🆕 2026-05-27 v3.103 — id required by `startMenuOverridesListener`
    // (line ~1192) so it can attach the scoped onSnapshot live-sync ONLY
    // while a customer is actively browsing the wallet menu. Without this
    // id, `_syncLiveListener` could never find the element and the live
    // listener never attached — onSnapshot was effectively dead code.
    // Same id is also used by the v3.39 menu-firestore poll gate (line ~807).
    var menuContent=document.createElement('div');menuContent.id='wallet-menu-content';inner.appendChild(menuContent);

    function currentMenuData(){
      // 🔴 2026-05-13 (Khushi) — scoped to active tab (see oninput above).
      if(menuQuery.trim()) return _filterMenu(hodGetMenuByTab(tabState.active),menuQuery);
      return hodGetMenuByTab(tabState.active);
    }
    function _applyVegFilter(menuData){
      if(!filterState.vegOnly) return menuData||[];
      var out=[];
      (menuData||[]).forEach(function(c){
        var hits=c.items.filter(function(it){return it.v===true;});
        if(hits.length) out.push({cat:c.cat,items:hits});
      });
      return out;
    }
    function buildMenu(menuData){
      menuData=_applyVegFilter(menuData);
      // Drop OOS items + empty cats
      var visibleCats=[];
      menuData.forEach(function(c){
        var v=(c.items||[]).filter(function(it){var ov=_ovFor(it.n);return !(ov&&ov.outOfStock);});
        if(v.length) visibleCats.push({cat:c.cat,items:v});
      });
      if(!visibleCats.length){
        menuContent.innerHTML='<div style="text-align:center;padding:40px 8px;color:#3D3D3D;font-size:13px;">No items in this section yet.</div>';
        return;
      }
      if(tabState.sub>=visibleCats.length) tabState.sub=0;

      // Sub-category chip row (wrapped, all visible)
      var subRow=document.createElement('div');
      subRow.className='wv-subrow';
      visibleCats.forEach(function(c,i){
        var chip=document.createElement('button');
        chip.className='wv-subchip'+(i===tabState.sub?' on':'');
        chip.textContent=c.cat;
        chip.onclick=function(){tabState.sub=i;menuContent.innerHTML='';buildMenu(menuData);};
        subRow.appendChild(chip);
      });
      menuContent.appendChild(subRow);

      var active=visibleCats[tabState.sub];

      // Section title (uppercase, white)
      var st=document.createElement('div');
      st.className='wv-sectiontitle';
      st.textContent=active.cat;
      menuContent.appendChild(st);

      var listWrap=document.createElement('div');
      menuContent.appendChild(listWrap);

      active.items.forEach(function(item){
        var key=active.cat+'|'+item.n;
        var ov=_ovFor(item.n);
        var eff=_effPrice(item.n,item.p);
        var hasDisc=eff!==item.p;
        var row=document.createElement('div');
        row.className='wv-row';
        row.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:10px;';
        var isVeg=item.v===true;
        var vegDot=typeof item.v!=='undefined'?'<span class="wv-vegdot" style="color:'+(isVeg?'#00C864':'#FF5733')+';"></span>':'';
        var priceHtml=hasDisc
          ? '<span style="text-decoration:line-through;color:rgba(0,0,0,.4);margin-right:6px;font-weight:600;">\u20b9'+item.p+'</span>'
            +'<span style="color:#000;font-weight:900;">\u20b9'+eff+'</span>'
            +(ov && ov.discountReason ? '<span style="color:rgba(242,199,68,.75);font-size:10px;margin-left:6px;font-weight:600;">\u00b7 '+sanitize(ov.discountReason)+'</span>' : '')
          : '<span style="color:#000;font-weight:900;">\u20b9'+item.p+'</span>';
        row.innerHTML='<div style="flex:1;min-width:0;"><div style="display:flex;align-items:center;font-size:13px;font-weight:800;color:#000;letter-spacing:.4px;">'+vegDot+'<span style="text-transform:uppercase;">'+sanitize(item.n)+'</span></div>'
          +'<div style="font-size:14px;font-family:var(--ff);font-weight:800;margin-top:6px;letter-spacing:.3px;">'+priceHtml+'</div></div>';
        var ctrl=document.createElement('div');ctrl.style.cssText='display:flex;align-items:center;gap:10px;flex-shrink:0;';
        var qty=cart[key]?cart[key].qty:0;
        if(qty===0){
          var addBtn=document.createElement('button');
          addBtn.className='wv-add';
          addBtn.textContent='Add +';
          addBtn.onclick=function(){
            cart[key]={n:item.n,p:_effPrice(item.n,item.p),cat:active.cat,qty:1,t:item.t||'drink',alc:item.alc===false?false:(item.t==='food'?false:true)};
            updateCartBar();updateTabFooter();
            menuContent.innerHTML='';buildMenu(menuData);
          };
          ctrl.appendChild(addBtn);
        } else {
          var minB=document.createElement('button');minB.className='wv-qbtn';minB.textContent='\u2212';
          minB.onclick=function(){
            if(!cart[key]){menuContent.innerHTML='';buildMenu(menuData);return;}
            if(cart[key].qty>1)cart[key].qty--;else delete cart[key];
            updateCartBar();updateTabFooter();
            menuContent.innerHTML='';buildMenu(menuData);
          };
          var qtySpan=document.createElement('span');qtySpan.className='wv-qty';qtySpan.textContent=qty;
          var plusB=document.createElement('button');plusB.className='wv-qbtn';plusB.textContent='+';
          plusB.onclick=function(){
            if(!cart[key]){cart[key]={n:item.n,p:_effPrice(item.n,item.p),cat:active.cat,qty:1,t:item.t||'drink',alc:item.alc===false?false:(item.t==='food'?false:true)};}
            else{cart[key].qty++;}
            updateCartBar();updateTabFooter();
            menuContent.innerHTML='';buildMenu(menuData);
          };
          ctrl.appendChild(minB);ctrl.appendChild(qtySpan);ctrl.appendChild(plusB);
        }
        row.appendChild(ctrl);listWrap.appendChild(row);
      });
    }

      // ══ RUNNING TAB FOOTER ══
      var submitCard=document.createElement('div');
      submitCard.id='wallet-tab-footer';
      submitCard.style.cssText='background:rgba(244,244,240,.97);backdrop-filter:blur(14px);padding:18px 0 28px;margin-top:24px;border-top:2px solid #000;';

      // Running Tab — the BIG, dominant line. This is what the customer
      // owes for everything already placed (confirmed orders). Tax-inclusive.
      var tabRow=document.createElement('div');
      tabRow.style.cssText='display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:2px;';
      tabRow.innerHTML='<span style="font-size:12px;color:#3D3D3D;text-transform:uppercase;letter-spacing:1.2px;font-weight:700;">Running Tab</span>'
        +'<span id="tab-running-total" style="font-size:24px;font-weight:900;color:#000;">₹0</span>';
      submitCard.appendChild(tabRow);

      // Tiny tax-inclusive hint sitting RIGHT under the Running Tab — taps
      // to expand a per-line GST/SC/CGST breakdown. Collapsed by default
      // so the line stays clean. (Khushi spec 2026-05-13 v3 — moved here
      // from below the Done Ordering button so customers see it next to
      // the amount it's actually inclusive of.)
      var taxHintTop=document.createElement('div');
      taxHintTop.id='tab-taxhint-top';
      taxHintTop.style.cssText='display:flex;justify-content:flex-end;align-items:center;gap:4px;margin-bottom:10px;font-size:10px;color:rgba(0,0,0,.5);font-style:italic;cursor:pointer;user-select:none;';
      taxHintTop.innerHTML='Inclusive of all taxes <span style="opacity:.7;">\u25be</span>';
      var taxBoxTop=document.createElement('div');
      taxBoxTop.id='tab-taxbox-top';
      taxBoxTop.style.cssText='display:none;margin-bottom:12px;padding:10px 14px;background:#fff;border:2px solid #000;border-radius:8px;font-size:11px;color:#3D3D3D;font-family:var(--ff);line-height:1.7;';
      taxHintTop.onclick=function(){
        var open=taxBoxTop.style.display==='block';
        if(open){taxBoxTop.style.display='none';taxHintTop.innerHTML='Inclusive of all taxes <span style="opacity:.7;">\u25be</span>';return;}
        try{
          var allItems=[];
          (tabRounds||[]).forEach(function(r){(r.items||[]).forEach(function(i){allItems.push(i);});});
          // Also include unplaced cart items so the breakdown matches what
          // the customer is about to confirm.
          Object.values(cart).forEach(function(it){allItems.push(it);});
          // 🆕 2026-06-08 v3.218 (Khushi) — pass the SAME discount/SC args as the
          // RUNNING TAB header + VIEW BILL so the expandable breakdown's Grand total
          // always matches the header (no two different totals on discounted bills).
          var bd=hodComputeBreakdown(allItems, Number(cv.billDiscountPct||0), (cv.billScOn!==false));
          var rows='';
          if(bd.foodSubtotal>0) rows+='<div style="display:flex;justify-content:space-between;"><span>Food subtotal</span><span>\u20B9'+bd.foodSubtotal.toFixed(0)+'</span></div>';
          if(bd.alcSubtotal>0)  rows+='<div style="display:flex;justify-content:space-between;"><span>Liquor subtotal</span><span>\u20B9'+bd.alcSubtotal.toFixed(0)+'</span></div>';
          if(bd.nonAlcSubtotal>0) rows+='<div style="display:flex;justify-content:space-between;"><span>Beverages subtotal</span><span>\u20B9'+bd.nonAlcSubtotal.toFixed(0)+'</span></div>';
          rows+='<div style="display:flex;justify-content:space-between;"><span>Service charge (10%)</span><span>\u20B9'+bd.serviceCharge.toFixed(0)+'</span></div>';
          rows+='<div style="display:flex;justify-content:space-between;"><span>GST (5%)</span><span>\u20B9'+bd.gst.toFixed(0)+'</span></div>';
          rows+='<div style="display:flex;justify-content:space-between;border-top:1px solid rgba(0,0,0,.12);margin-top:6px;padding-top:6px;color:#000;font-weight:700;"><span>Grand total</span><span>\u20B9'+bd.grandTotal+'</span></div>';
          taxBoxTop.innerHTML=rows||'<div style="text-align:center;opacity:.6;">No items yet.</div>';
        }catch(e){taxBoxTop.innerHTML='<div style="text-align:center;opacity:.6;">Breakdown unavailable.</div>';}
        taxBoxTop.style.display='block';
        taxHintTop.innerHTML='Inclusive of all taxes <span style="opacity:.7;">\u25B4 hide</span>';
      };
      submitCard.appendChild(taxHintTop);
      submitCard.appendChild(taxBoxTop);

      // "This Round" — the NEW items being added now (still in cart, not
      // yet placed). Smaller line so the customer reads Running Tab first,
      // then sees what they're about to add.
      var totalRow=document.createElement('div');
      totalRow.style.cssText='display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding:8px 12px;background:rgba(242,199,68,.05);border:1px dashed rgba(242,199,68,.18);border-radius:8px;';
      totalRow.innerHTML='<span style="font-size:11px;color:#3D3D3D;text-transform:uppercase;letter-spacing:1.2px;font-weight:700;">+ This Round</span>'
        +'<span id="tab-round-total" style="font-size:16px;font-weight:800;color:#000;">₹0</span>';
      submitCard.appendChild(totalRow);

      var itemLine=document.createElement('div');
      itemLine.id='tab-item-line';
      itemLine.style.cssText='margin-bottom:14px;min-height:14px;';
      submitCard.appendChild(itemLine);

      function renderCartSummary(){
        var il=document.getElementById('tab-item-line');
        if(!il)return;
        il.innerHTML='';
        var items=Object.keys(cart);
        if(!items.length){il.style.display='none';return;}
        il.style.display='block';
        il.innerHTML='<div style="font-size:10px;font-weight:800;color:#3D3D3D;letter-spacing:1px;margin-bottom:6px;">YOUR ORDER</div>';
        items.forEach(function(key){
          var it=cart[key];
          var row=document.createElement('div');
          row.style.cssText='display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(0,0,0,.04);';
          var info=document.createElement('div');
          info.style.cssText='flex:1;min-width:0;';
          info.innerHTML='<div style="font-size:12px;color:#000;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+sanitize(it.n)+'</div>'
            +'<div style="font-size:10px;color:#3D3D3D;">₹'+it.p+' each</div>';
          var controls=document.createElement('div');
          controls.style.cssText='display:flex;align-items:center;gap:8px;flex-shrink:0;margin-left:10px;';
          var minB=document.createElement('button');
          minB.style.cssText='width:28px;height:28px;border-radius:7px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#FF5733;font-size:14px;font-weight:900;cursor:pointer;display:flex;align-items:center;justify-content:center;';
          minB.textContent='−';
          var qtySpan=document.createElement('span');
          qtySpan.style.cssText='font-size:14px;font-weight:900;color:#000;min-width:16px;text-align:center;';
          qtySpan.textContent=it.qty;
          var plusB=document.createElement('button');
          plusB.style.cssText='width:28px;height:28px;border-radius:7px;background:rgba(0,200,100,.1);border:1px solid rgba(0,200,100,.3);color:#00C864;font-size:14px;font-weight:900;cursor:pointer;display:flex;align-items:center;justify-content:center;';
          plusB.textContent='+';
          var priceSpan=document.createElement('span');
          priceSpan.style.cssText='font-size:13px;font-weight:800;color:#000;min-width:50px;text-align:right;';
          priceSpan.textContent='₹'+(it.p*it.qty);
          (function(k){
            minB.onclick=function(){
              if(cart[k].qty>1)cart[k].qty--;else delete cart[k];
              updateCartBar();updateTabFooter();
              // Rebuild current menu to reflect changes
              menuContent.innerHTML='';buildMenu(currentMenuData());
            };
            plusB.onclick=function(){
              cart[k].qty++;
              updateCartBar();updateTabFooter();
              menuContent.innerHTML='';buildMenu(currentMenuData());
            };
          })(key);
          controls.appendChild(minB);controls.appendChild(qtySpan);controls.appendChild(plusB);controls.appendChild(priceSpan);
          row.appendChild(info);row.appendChild(controls);
          il.appendChild(row);
        });
      }

      var placeBtn=document.createElement('button');
      placeBtn.id='tab-place-btn';
      placeBtn.className='wv-place';
      placeBtn.style.cssText='margin-bottom:10px;opacity:.45;';
      placeBtn.textContent=cv.isTableBooking?'🍽️  Place Order':'🍹 Place Order';
      submitCard.appendChild(placeBtn);

      // 2026-05-13 (Khushi spec, v2) — Done Ordering: keep Digitory red but
      // refine the typography so it doesn't shout. Headline now uses Playfair
      // (matches HOD wordmark, less aggressive than condensed sans), softer
      // padding, gentler shadow. Subtitle moved out of the button into a
      // dedicated tax-hint pill underneath that ALSO restores the
      // "Inclusive of all taxes" line that used to live in the (now removed)
      // bottom cart bar — guests were complaining nothing told them the
      // sticker prices already include GST + service charge.
      var checkoutWrap=document.createElement('div');
      checkoutWrap.id='tab-checkout-wrap';
      checkoutWrap.style.cssText=cv.isTableBooking?'':'display:none;';

      var checkoutBtn=document.createElement('button');
      checkoutBtn.id='tab-checkout-btn';
      checkoutBtn.style.cssText='width:100%;padding:16px 18px;border-radius:8px;background:#23A094;border:2px solid #000;color:#fff;cursor:pointer;font-family:var(--ff);font-size:18px;font-weight:800;letter-spacing:.5px;box-shadow:4px 4px 0 #000;display:flex;align-items:center;justify-content:center;gap:10px;';
      checkoutBtn.innerHTML='<span style="font-size:18px;">🧾</span><span>Done Ordering? Settle Your Bill</span>';
      checkoutWrap.appendChild(checkoutBtn);
      // (Tax-hint pill moved up under Running Tab — see taxHintTop above.)
      submitCard.appendChild(checkoutWrap);

      inner.appendChild(submitCard);

      // ── Request a Song — eye-catching card after Place Order
      // ONLY show for nightlife covers (ground floor) — NOT for dining/rooftop tables.
      // Dining and rooftop have curated ambient music — letting customers hijack
      // it would ruin the vibe. Aggregator bookings are all dining/rooftop too.
      var _bookRef = cv.ref || bookingRef || '';
      var _isAgg = cv.isAggregator || (cv.source && cv.source !== 'inhouse') || _bookRef.startsWith('AGG-');
      var _isDiningOrRooftop = cv.isTableBooking && (cv.floor === 'dining' || cv.floor === 'rooftop' || _isAgg);
      if(!_isDiningOrRooftop){
        var songCard=document.createElement('div');
        songCard.style.cssText='background:rgba(255,51,102,.15);border:2px solid rgba(255,51,102,.35);border-radius:8px;padding:20px;margin:20px 0;cursor:pointer;transition:all .2s;box-shadow:0 0 20px rgba(255,51,102,.08);';
        songCard.innerHTML='<div style="text-align:center;margin-bottom:12px;"><span style="font-size:32px;">🎵</span></div>'
          +'<div style="text-align:center;font-size:18px;font-weight:900;color:#000;margin-bottom:6px;letter-spacing:-.3px;">Request a Song</div>'
          +'<div style="text-align:center;font-size:13px;color:rgba(0,0,0,.6);margin-bottom:16px;line-height:1.4;">Search any song in the world — we\'ll play it for you tonight!</div>'
          +'<div style="text-align:center;"><div style="display:inline-flex;gap:8px;align-items:center;padding:10px 24px;background:#FF5733;border-radius:8px;font-size:14px;font-weight:700;color:#000;">Pick Your Song →</div></div>'
          +'<div style="display:flex;justify-content:center;gap:16px;margin-top:14px;">'
          +'<div style="font-size:10px;color:rgba(0,0,0,.4);text-transform:uppercase;letter-spacing:1px;">Free</div>'
          +'<div style="font-size:10px;color:rgba(242,199,68,.6);text-transform:uppercase;letter-spacing:1px;">Priority ₹99</div>'
          +'<div style="font-size:10px;color:rgba(255,51,102,.6);text-transform:uppercase;letter-spacing:1px;">VIP ₹299</div>'
          +'</div>';
        songCard.onclick=function(){
          var reqUrl='request.html?ref='+encodeURIComponent(bookingRef)+'&name='+encodeURIComponent(name);
          window.open(reqUrl,'_blank');
        };
        inner.appendChild(songCard);
      }

      // ── Tab state
      var tabRounds=(cv.tabRounds&&Array.isArray(cv.tabRounds))?cv.tabRounds:[];
      function getTabTotal(){return tabRounds.reduce(function(s,r){return s+(r.roundTotal||0);},0);}
      function getRoundNum(){return tabRounds.length+1;}

      function updateTabFooter(){
        var ct=getCartTotal();
        var tt=getTabTotal();
        var el=document.getElementById('tab-round-total');
        var te=document.getElementById('tab-running-total');
        var il=document.getElementById('tab-item-line');
        if(el)el.textContent='₹'+ct;
        // 🆕 2026-06-08 v3.218 (Khushi) — RUNNING TAB placed total now ALWAYS uses
        // the discount/SC-aware computed breakdown (placedGrand) so it equals the
        // bar bill + VIEW BILL grand total exactly. The prior v3.217 anchor to
        // cv.coverUsed drifted (showed ₹1680 while the real bill was ₹1650) and is
        // removed along with the "₹X used / total" cover badge. "+ THIS ROUND"
        // below still shows the live cart at menu price.
        var placedGrand;
        try{
          var _allPlaced=[];
          tabRounds.forEach(function(r){(r.items||[]).forEach(function(i){_allPlaced.push(i);});});
          placedGrand=_allPlaced.length?hodComputeBreakdown(_allPlaced, Number(cv.billDiscountPct||0), (cv.billScOn!==false)).grandTotal:0;
        }catch(_e){placedGrand=tt;}
        var _placedDisplay=placedGrand;
        if(te)te.textContent=(_placedDisplay>0||ct>0)?'₹'+(_placedDisplay+ct)+' total':'₹'+ct;
        renderCartSummary();
        if(placeBtn){placeBtn.style.opacity=ct>0?'1':'.45';}
        var hasTab=(_placedDisplay+ct)>0;
        if(checkoutBtn){
          checkoutBtn.style.color='#fff';
          checkoutBtn.style.borderColor=hasTab?'rgba(0,0,0,.3)':'rgba(0,0,0,.12)';
        }
      }

      var _origUCB=updateCartBar;
      updateCartBar=function(){_origUCB();updateTabFooter();};
      updateTabFooter();

      // ── Place Order (saves round, clears cart)
      placeBtn.onclick=function(){
        var ct=getCartTotal();
        if(!ct){showToast('Select items first','err',2000);return;}

        // 🆕 2026-06-02 v3.183 (Khushi) — shared "park this order for the
        // BARTENDER" routine. Used by BOTH the picker's I'M AT THE BAR button
        // AND the new RECHARGE AT BAR button on the insufficient-balance card.
        // Writes the cart as a 'preparing' round on the cover with
        // hasIncomingCustomerOrder so the POS BarMode dashboard surfaces it on
        // scan/search, stamps the durable atBar flag, then shows the
        // "show this to the bartender" screen. Fail-open: write errors still
        // show the screen so the guest knows to walk to the bar.
        function _parkOrderForBartender(srcTag){
          var _items=Object.values(cart);
          try {
            var _bRoundItems=_items.map(function(it){return {n:it.n,p:it.p,qty:it.qty,cat:it.cat,t:it.t||"drink",alc:it.alc===false?false:(it.t==="food"?false:true)};});
            var _bNewRound={roundNum:getRoundNum(),items:_bRoundItems,roundTotal:ct,status:'preparing',placedAt:new Date().toISOString(),source:srcTag};
            var _bCoverDocId=(cv.bookingId||cv.ref||'').replace(/[^a-zA-Z0-9_-]/g,'_');
            var _bUpdatedRounds=tabRounds.map(function(r){
              if(r.status==='activated')return Object.assign({},r,{status:'served',servedAt:new Date().toISOString()});
              return r;
            }).concat([_bNewRound]);
            if (firestore) {
              firestore.collection('covers').doc(_bCoverDocId).set({
                tabRounds:_bUpdatedRounds,tabTotal:getTabTotal()+ct,
                ref:cv.ref||cv.bookingId||'',name:cv.name||'',phone:cv.phone||'',
                isTableBooking:!!cv.isTableBooking,tableId:cv.tableId||'',floorLabel:cv.floorLabel||'',
                hasIncomingCustomerOrder:true,
                incomingOrderAt:new Date().toISOString(),
                incomingOrderSource:srcTag,
                atBar:true,
                atBarAt:new Date().toISOString()
              },{merge:true}).then(function(){
                tabRounds=_bUpdatedRounds;
                cart={};
                try { updateCartBar(); } catch(_){}
                try { renderRoundsHistory(); } catch(_){}
              }).catch(function(err){
                try { console.warn('[park-bar] covers write failed (popup-only fallback)', err && err.message); } catch(_){}
              });
            }
          } catch(_eBar) { try { console.warn('[park-bar] write threw',_eBar); } catch(_){} }
          // "show this to the bartender" screen
          var _bsOv=document.createElement('div');
          _bsOv.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:10001;display:flex;align-items:flex-start;justify-content:center;padding:24px 16px 60px;backdrop-filter:blur(10px);animation:fadeIn .25s ease;overflow-y:auto;';
          var _bsMd=document.createElement('div');
          _bsMd.style.cssText='background:#F4F4F0;border:2px solid #000;border-radius:8px;padding:24px 22px;width:100%;max-width:400px;box-shadow:6px 6px 0 #FF90E8;position:relative;';
          var _bsHdr='<div style="text-align:center;margin-bottom:18px;">'
            +'<div style="font-size:48px;margin-bottom:6px;">🍸</div>'
            +'<div style="font-family:var(--ff);font-size:22px;font-weight:900;color:#000;letter-spacing:.4px;line-height:1.15;margin-bottom:4px;">SHOW THIS TO THE BARTENDER</div>'
            +'<div style="font-size:12px;color:#3D3D3D;line-height:1.5;">They\'ll place your order on the POS.</div>'
            +'</div>';
          var _refTxt=sanitize(cv.ref||cv.bookingId||'');
          var _bsRef='<div style="background:#FF90E8;border:2px solid #000;border-radius:12px;padding:12px 14px;margin-bottom:14px;text-align:center;">'
            +'<div style="font-size:10px;font-weight:800;color:#3D3D3D;letter-spacing:1.5px;margin-bottom:4px;">WALLET / BOOKING REF</div>'
            +'<div style="font-family:var(--ff);font-size:22px;font-weight:900;color:#000;letter-spacing:1.5px;">'+_refTxt+'</div>'
            +(cv.tableId?'<div style="font-size:12px;color:#3D3D3D;margin-top:4px;">Table '+sanitize(cv.tableId)+(cv.floorLabel?' · '+sanitize(cv.floorLabel):'')+'</div>':'')
            +'</div>';
          var _bsItemsHtml='<div style="background:rgba(0,0,0,.04);border:1px solid rgba(0,0,0,.1);border-radius:12px;padding:12px 14px;margin-bottom:14px;">'
            +'<div style="font-size:10px;font-weight:800;color:#3D3D3D;letter-spacing:1.5px;margin-bottom:8px;text-align:center;">YOUR ORDER</div>';
          _items.forEach(function(it){
            _bsItemsHtml+='<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:14px;border-bottom:1px dashed rgba(0,0,0,.06);">'
              +'<span style="color:#000;font-weight:600;">'+it.qty+'× '+sanitize(it.n)+'</span>'
              +'<span style="color:#000;font-weight:700;">₹'+(it.p*it.qty).toLocaleString('en-IN')+'</span>'
              +'</div>';
          });
          _bsItemsHtml+='<div style="display:flex;justify-content:space-between;padding:10px 0 2px;font-size:16px;font-weight:900;border-top:1.5px solid rgba(255,144,232,.3);margin-top:6px;">'
            +'<span style="color:#000;">TOTAL</span><span style="color:#000;">₹'+ct.toLocaleString('en-IN')+'</span>'
            +'</div></div>';
          var _bsBal='<div style="background:rgba(34,197,94,.08);border:1.5px solid rgba(34,197,94,.4);border-radius:12px;padding:10px 14px;margin-bottom:14px;text-align:center;">'
            +'<div style="font-size:10px;font-weight:800;color:#3D3D3D;letter-spacing:1.5px;margin-bottom:2px;">WALLET BALANCE</div>'
            +'<div style="font-size:22px;font-weight:900;color:#15803D;font-variant-numeric:tabular-nums;">₹'+bal.toLocaleString('en-IN')+'</div>'
            +'</div>';
          var _bsHint='<div style="font-size:11px;color:#3D3D3D;line-height:1.5;text-align:center;margin-bottom:14px;">Bartender will deduct from your wallet using the ref above.</div>';
          // 🆕 2026-06-03 v3.203 (Khushi): QR inside the "show this to the bartender"
          // popup so the bartender can SCAN the wallet (same ?verify= link as the
          // main wallet QR) instead of keying in the ref by hand.
          var _bsQR='<div style="background:#fff;border:2px solid #000;border-radius:12px;padding:16px;margin-bottom:14px;text-align:center;">'
            +'<div style="font-size:10px;font-weight:800;color:#000;letter-spacing:1.5px;margin-bottom:10px;">SCAN TO PULL UP WALLET</div>'
            +'<div id="bs-qr-wrap" style="width:180px;height:180px;margin:0 auto;background:#fff;display:flex;align-items:center;justify-content:center;"></div>'
            +'</div>';
          _bsMd.innerHTML=_bsHdr+_bsQR+_bsRef+_bsItemsHtml+_bsBal+_bsHint;
          generateLocalQR('bs-qr-wrap','https://hodclub.in/?verify='+encodeURIComponent(cv.ref||cv.bookingId||cv.id||''));
          var _bsCloseX=document.createElement('button');
          _bsCloseX.setAttribute('aria-label','Close');
          _bsCloseX.innerHTML='✕';
          _bsCloseX.style.cssText='position:absolute;top:10px;right:10px;width:34px;height:34px;border-radius:8px;background:#fff;border:2px solid #000;color:#000;font-size:16px;font-weight:900;cursor:pointer;font-family:var(--ff);line-height:1;display:flex;align-items:center;justify-content:center;box-shadow:2px 2px 0 #000;z-index:2;';
          _bsCloseX.onclick=function(){_bsOv.remove();};
          _bsMd.appendChild(_bsCloseX);
          var _bsBackBtn=document.createElement('button');
          _bsBackBtn.style.cssText='width:100%;padding:15px;border-radius:10px;background:#FF90E8;border:2px solid #000;color:#000;font-size:14px;font-weight:900;cursor:pointer;font-family:var(--ff);letter-spacing:.5px;text-transform:uppercase;box-shadow:4px 4px 0 #000;';
          _bsBackBtn.textContent='← Back to Menu';
          _bsBackBtn.onclick=function(){_bsOv.remove();};
          _bsMd.appendChild(_bsBackBtn);
          _bsOv.appendChild(_bsMd);
          document.body.appendChild(_bsOv);
        }

        // 🔴 2026-05-25 (Khushi GO-LIVE) — WHERE-ARE-YOU PICKER for
        // TABLE bookings that ALSO have an activated wallet/cover.
        // Customer with both a table AND a wallet can choose to walk
        // up to the bar instead of waiting for the captain. Two paths:
        //   • I'M AT MY TABLE  → existing flow (captain ping + KOT)
        //   • I'M AT THE BAR   → DO NOT notify captain; show a
        //                        "show this to the bartender" screen
        //                        with the cart so the bartender can
        //                        ring it in manually on POS.
        // Gate: cv.isTableBooking && cv.coverActivated>0. Pure tables
        // (no cover) stay on the captain-only path. Pure covers
        // (no table) don't see this at all.
        // Idempotent: `placeBtn._loc` flag set after picker selection
        // so the recursive call from "TABLE" branch skips the picker.
        // 🆕 2026-05-27 v3.66 (Khushi LIVE-NIGHT) — TABLE BOOKINGS SKIP PICKER.
        // HODTAB / TBL- / AGG- guests booked a TABLE — they're not at the bar,
        // they're at their table waiting for captain. The "Where are you?" modal
        // is only meaningful for hybrid table-AND-cover walk-ins; for true table
        // bookings it's confusing + lets them pick AT BAR and miss captain
        // service. Force `_loc='table'` so the picker is bypassed and the
        // captain-ping branch runs straight away.
        var _refIsTable = !!(bookingRef && (bookingRef.indexOf('HODTAB')===0 || bookingRef.indexOf('TBL-')===0 || bookingRef.indexOf('AGG-')===0));
        if (_refIsTable && !placeBtn._loc) {
          placeBtn._loc = 'table';
          try { placeBtn.onclick(); } finally { placeBtn._loc = null; }
          return;
        }
        if ((cv.isTableBooking || cv.linkedTableRef || cv.tableId) && (cv.coverActivated||0) > 0 && !placeBtn._loc){
          // 🆕 2026-06-08 (Khushi) — once the table session has ENDED (released), the
          // guest should never see the "Where are you?" picker again — every further
          // round goes straight to the bartender. We persist a per-booking ack flag
          // the moment a DEFINITIVE release is detected (see _showSessionEndedPopup);
          // if it's set, skip the picker entirely and park the order for the bar.
          var _endedAckKey='hod_tbl_ended_'+(cv.ref||cv.bookingId||'');
          var _endedAck=false; try{_endedAck=!!localStorage.getItem(_endedAckKey);}catch(_e0){}
          if(_endedAck){
            placeBtn._loc=null;
            try{ _parkOrderForBartender('customer_self_order_bar'); }catch(_e1){}
            return;
          }
          var _lpOv=document.createElement('div');
          _lpOv.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(8px);animation:fadeIn .25s ease;';
          var _lpMd=document.createElement('div');
          _lpMd.style.cssText='background:#F4F4F0;border:2px solid #000;border-radius:8px;padding:28px 24px 22px;width:100%;max-width:380px;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.7),0 0 40px #F4F4F0;';
          _lpMd.innerHTML=
            '<div style="font-size:46px;margin-bottom:8px;line-height:1;">📍</div>'
            +'<div style="font-family:var(--ff);font-size:22px;font-weight:800;color:#000;margin-bottom:6px;letter-spacing:.3px;">Where are you?</div>'
            +'<div style="font-size:13px;color:#aaa;line-height:1.5;margin-bottom:20px;">Tell us where you\'d like to order from.</div>';
          var _tableBtn=document.createElement('button');
          _tableBtn.style.cssText='width:100%;padding:18px;border-radius:8px;background:rgba(120,120,120,.18);border:1.5px dashed rgba(255,144,232,.35);color:rgba(255,255,255,.55);font-size:15px;font-weight:900;cursor:wait;font-family:var(--ff);margin-bottom:12px;letter-spacing:.3px;display:flex;align-items:center;justify-content:center;gap:10px;';
          // 🆕 2026-05-25 v2 (architect fix) — Button starts DISABLED. Default
          // to "stale" until the firestore freshness query resolves. Closes
          // the race where a fast tap before the query returns would bypass
          // the guardrail and ping the WRONG captain card.
          _tableBtn._stale=true;
          _tableBtn._verifying=true;
          _tableBtn.innerHTML='<span style="font-size:18px;">⏳</span><span>CHECKING TABLE SESSION…</span>';
          _tableBtn.onclick=function(){
            if (_tableBtn._verifying) { showToast('Checking your table — one moment','warn',1500); return; }
            if (_tableBtn._stale) return; // hard-blocked when query resolved stale
            _lpOv.remove();
            placeBtn._loc='table';
            try { placeBtn.onclick(); } finally { placeBtn._loc=null; }
          };
          _lpMd.appendChild(_tableBtn);
          // 🆕 2026-05-25 (Khushi STRATEGY A) — STALE-TABLE GUARDRAIL.
          // Loophole: customer's original table can be RELEASED + re-seated
          // to a NEW guest before customer redeems remaining wallet. If
          // customer then picks "I'M AT MY TABLE", the captain ping fires
          // on the WRONG table (the new guest's card) → wrong attribution.
          // Mitigation: at picker-show time, look up tableReservations with
          // this cover's ref. If NONE active (status released/closed/etc),
          // OR active doc's phone differs from cv.phone → grey out the
          // table button + show "🚫 TABLE SESSION ENDED" overlay text +
          // nudge customer to the bar branch (which Strategy C makes
          // bartender-visible as a backstop). Fail-open: if firestore
          // query fails, leave button enabled (existing behaviour).
          // 🆕 2026-05-25 v3.1 (Khushi MESSAGE CLARITY) — Two clear options
          // when the table is no longer bound to this customer:
          //   1. Get in touch with the captain for a new table
          //   2. Order at the bar and redeem the remaining wallet there
          // Both paths preserve the wallet balance — no money is lost.
          var _staleHint=document.createElement('div');
          _staleHint.style.cssText='display:none;font-size:12px;color:#F87171;margin:-4px 0 14px;line-height:1.55;letter-spacing:.2px;text-align:center;font-weight:600;padding:10px 12px;background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.25);border-radius:8px;';
          _staleHint.innerHTML='<div style="font-weight:800;font-size:12px;margin-bottom:4px;letter-spacing:.4px;">🚫 YOUR TABLE SESSION HAS ENDED</div><div style="color:#FCA5A5;font-weight:500;font-size:11px;">Please get in touch with the <b style="color:#F87171;">CAPTAIN</b> for a new table,<br>OR tap <b style="color:#000;">🍸 I\'M AT THE BAR</b> below to order &amp; redeem your wallet at the bar.</div>';
          _lpMd.appendChild(_staleHint);
          // 🆕 2026-05-25 v3 (Khushi BUG REPORT) — Identity check is now
          // LENIENT. v2 required strict phone match on BOTH sides; but
          // Door's table-activate flow doesn't always propagate the
          // phone onto the cover doc, so legit customers were getting
          // a false-positive "TABLE SESSION ENDED" the moment they
          // re-opened their wallet. New rule: the Firestore query
          // already restricts to `where linkedCoverRef == cv.ref` —
          // that equality alone proves the booking is still bound to
          // THIS wallet (Door release clears the link before re-seating).
          // We only escalate to a strict phone match when BOTH sides
          // actually have phone digits; if either is missing, the ref
          // equality + non-dead status is treated as proof-enough.
          // Fail-open: any query error leaves button enabled.
          var _normP=function(p){ return String(p||'').replace(/\D/g,'').slice(-10); };
          var _cvPhoneN=_normP(cv.phone);
          var _markStale=function(reason){
            _tableBtn._stale=true; _tableBtn._verifying=false;
            _tableBtn.style.background='rgba(120,120,120,.18)';
            _tableBtn.style.color='rgba(255,255,255,.45)';
            _tableBtn.style.cursor='not-allowed';
            _tableBtn.style.border='1.5px dashed rgba(248,113,113,.45)';
            _tableBtn.innerHTML='<span style="font-size:22px;opacity:.6;">🚫</span><span>TABLE SESSION ENDED</span>';
            _staleHint.style.display='block';
            try { console.warn('[picker] table marked stale:', reason); } catch(_){}
          };
          var _markFresh=function(){
            _tableBtn._stale=false; _tableBtn._verifying=false;
            _tableBtn.style.background='#FF90E8';
            _tableBtn.style.color='#000';
            _tableBtn.style.cursor='pointer';
            _tableBtn.style.border='none';
            _tableBtn.innerHTML='<span style="font-size:22px;">🍽️</span><span>I\'M AT MY TABLE</span>';
          };
          // FAIL-SAFE TIMEOUT: if firestore never responds within 4s, stay
          // stale (do NOT silently let through). User can still pick bar.
          // 🆕 v3 FAIL-OPEN on timeout — was _markStale; now _markFresh
          // so a slow firestore round-trip doesn't lock out legitimate
          // customers. Stale-table loophole is a rare race; false-positive
          // on every customer is a real revenue hit. 4s is generous.
          var _staleTO=setTimeout(function(){ if (_tableBtn._verifying) _markFresh(); }, 4000);
          // 🆕 2026-05-25 v3.2 (Khushi BUG REPORT round 2) — TWO-LAYER lookup.
          // Khushi's SMK2 booking had a live captain card but my v3 query
          // `where linkedCoverRef==cv.ref` returned 0 docs (the link
          // wasn't written — either pre-dates linkCoverToTable, or door
          // used a different activate path). v3.2 now:
          //   1. PRIMARY: if cover has `linkedTableRef` (the table doc
          //      ID), look up THAT doc directly — fast, authoritative,
          //      one doc read.
          //   2. FALLBACK: original `where linkedCoverRef==cv.ref` query.
          //   3. SAFETY: if NEITHER finds a doc at all (link was never
          //      written), FAIL-OPEN — let the customer through. The
          //      original loophole (table re-seated to a NEW guest)
          //      only matters when a DIFFERENT name/phone is now there;
          //      we still catch that case via dead-status or phone-mismatch.
          var _isDeadStatus=function(st){
            st=String(st||'').toLowerCase();
            return (st==='released'||st==='closed'||st==='paid'||st==='cancelled'||st==='checked_out'||st==='done'||st==='completed'||st==='void');
          };
          // 🆕 2026-05-25 v3.5 (Khushi DOUBLE-SPEND GUARD — extended) —
          // Captain-placed rounds live on `tableReservations.tabRounds`,
          // NOT on the cover doc. v3.3's check only saw customer-self-
          // order rounds. Reuse this helper from both the direct doc
          // lookup AND query fallback so any open captain round at the
          // table also locks the bar button.
          var _hasOpenRoundsFn=function(arr){
            try {
              return Array.isArray(arr) && arr.some(function(r){
                if (!r) return false;
                var st=String(r.status||'').toLowerCase();
                return st==='preparing' || st==='activated' || st==='served';
              });
            } catch(_){ return false; }
          };
          var _evalTableDoc=function(tr,sourceLabel){
            if (_isDeadStatus(tr.status)) { _markStale('table '+sourceLabel+' status: '+(tr.status||'?')); try { _unlockBarReleased('table dead-status: '+(tr.status||'?')); } catch(_){} try { _showSessionEndedPopup('table dead-status: '+(tr.status||'?')); } catch(_){} return; }
            var phN=_normP(tr.customerPhone||tr.phone);
            // Strict phone check ONLY when both sides have digits; protects
            // against re-seated tables without locking out customers whose
            // cover doc lacks phone data.
            if (_cvPhoneN && phN && phN!==_cvPhoneN) {
              _markStale('phone mismatch — table now seated under …'+phN.slice(-4));
              return;
            }
            _markFresh();
            // 🆕 v3.5 — fresh table; now check if captain has an open tab
            // on this table doc and lock the bar btn if so. Safe to call
            // even before _lockBarForOpenTab is assigned (no-op until then).
            if (_hasOpenRoundsFn(tr.tabRounds)) {
              try { if (typeof _lockBarForOpenTab === 'function') _lockBarForOpenTab('captain table rounds open'); } catch(_){}
            }
          };
          var _runQueryFallback=function(linkWasMissing){
            firestore.collection('tableReservations').where('linkedCoverRef','==',cv.ref).get().then(function(snap){
              clearTimeout(_staleTO);
              if (snap.empty) {
                // 🆕 2026-06-08 (Khushi) — if this cover HAD a linkedTableRef but
                // its table doc is GONE (direct lookup returned !exists) AND no
                // other reservation is linked to this wallet, the table was
                // RELEASED. releaseTable DELETES the tableReservations doc, so a
                // missing-link + empty-query is definitive proof the table session
                // ended. Mark the table button stale (→ "go to the bar" nudge) AND
                // UNLOCK the bar so the guest can redeem any remaining balance there
                // (no captain tab left to settle → no double-spend risk).
                if (linkWasMissing) {
                  try { console.warn('[picker] linked table released (doc gone + no re-link) — table stale, bar unlocked'); } catch(_){}
                  _markStale('table released — doc deleted');
                  try { _unlockBarReleased('table released'); } catch(_){}
                  try { _showSessionEndedPopup('table released — doc deleted'); } catch(_){}
                  return;
                }
                // No doc was ever linked to this wallet via the
                // where-field. Can't prove staleness either way — FAIL
                // OPEN. (Better to accidentally serve one re-seated
                // table than to block every legitimate customer.)
                try { console.warn('[picker] no linkedCoverRef match, fail-open'); } catch(_){}
                _markFresh(); return;
              }
              // Walk results; if any non-dead row matches identity → fresh.
              var fresh=false, lastReason='all linked reservations look dead', _anyOpenRounds=false;
              snap.forEach(function(d){
                var tr=d.data()||{};
                if (_isDeadStatus(tr.status)) { lastReason='all linked reservations dead'; return; }
                var phN=_normP(tr.customerPhone||tr.phone);
                if (_cvPhoneN && phN && phN!==_cvPhoneN) { lastReason='phone mismatch — re-seated to …'+phN.slice(-4); return; }
                fresh=true;
                // 🆕 v3.5 — track open captain rounds across any matching row
                if (_hasOpenRoundsFn(tr.tabRounds)) _anyOpenRounds=true;
              });
              if (fresh) {
                _markFresh();
                if (_anyOpenRounds) {
                  try { if (typeof _lockBarForOpenTab === 'function') _lockBarForOpenTab('captain table rounds open (via query)'); } catch(_){}
                }
              } else { _markStale(lastReason); }
            }).catch(function(e){
              clearTimeout(_staleTO);
              try { console.warn('[picker] query fallback failed, fail-open:', e && e.message); } catch(_){}
              _markFresh();
            });
          };
          try {
            if (!firestore || !cv.ref) {
              clearTimeout(_staleTO);
              _markFresh(); // can't check → let through
            } else if (cv.linkedTableRef) {
              // PRIMARY path — direct doc lookup
              firestore.collection('tableReservations').doc(cv.linkedTableRef).get().then(function(d){
                clearTimeout(_staleTO);
                if (!d.exists) { _runQueryFallback(true); return; }
                _evalTableDoc(d.data()||{},'doc');
              }).catch(function(e){
                clearTimeout(_staleTO);
                try { console.warn('[picker] direct lookup failed, falling back to query:', e && e.message); } catch(_){}
                _runQueryFallback(false);
              });
            } else {
              // No linkedTableRef on cover — use legacy where-query path
              _runQueryFallback(false);
            }
          } catch(_eStale) {
            clearTimeout(_staleTO);
            _markFresh();
            try { console.warn('[picker] stale-check threw, fail-open:', _eStale && _eStale.message); } catch(_){}
          }
          var _barBtn=document.createElement('button');
          _barBtn.style.cssText='width:100%;padding:18px;border-radius:8px;background:rgba(123,47,190,.15);border:1.5px solid rgba(123,47,190,.5);color:#000;font-size:15px;font-weight:900;cursor:pointer;font-family:var(--ff);margin-bottom:14px;letter-spacing:.3px;display:flex;align-items:center;justify-content:center;gap:10px;';
          _barBtn.innerHTML='<span style="font-size:22px;">🍸</span><span>I\'M AT THE BAR</span>';
          _barBtn.onclick=function(){
            _lpOv.remove();
            // 🆕 2026-06-02 v3.183 — all park-for-bartender logic now lives in
            // the shared _parkOrderForBartender() helper (top of placeBtn.onclick).
            _parkOrderForBartender('customer_self_order_bar');
          };
          // 🆕 2026-05-25 v3.3+v3.5 (Khushi DOUBLE-SPEND GUARD) — If the
          // customer has ANY open round (preparing / activated / served
          // but not yet settled) EITHER on the cover (customer-self-
          // order rounds) OR on the linked tableReservation
          // (captain-placed rounds), the bar button gets locked. The
          // table button stays enabled (adding to existing tab is safe —
          // captain owns it). The async stale-check above will also
          // call _lockBarForOpenTab() if it detects captain rounds on
          // the linked table doc (v3.5).
          // 🛟 FALLBACK: if reads fail, default OPEN — don't lock
          // legitimate customers out. The transactional balance check in
          // activateCoverOrder is the last-line backstop.
          var _tabHint=null;
          var _lockBarForOpenTab=function(reason){
            if (_barBtn._locked) return;
            _barBtn._locked=true;
            try { console.warn('[picker] bar locked:', reason||'open tab'); } catch(_){}
            if (!_tabHint) {
              _tabHint=document.createElement('div');
              _tabHint.style.cssText='font-size:12px;color:#000;margin:-4px 0 12px;line-height:1.55;letter-spacing:.2px;text-align:center;font-weight:600;padding:11px 13px;background:#FFF1F0;border:2px solid #E11900;border-radius:8px;';
              _tabHint.innerHTML='<div style="font-weight:900;font-size:12px;margin-bottom:5px;letter-spacing:.4px;color:#B91C1C;">❗ FINISH YOUR TABLE TAB FIRST</div><div style="color:#3D3D3D;font-weight:600;font-size:11px;">You have an open order at your table.<br>Ask your <b style="color:#000;">CAPTAIN</b> to print &amp; settle the bill,<br>then you can order at the bar.</div>';
              // Insert hint BEFORE the bar button if button already in DOM
              if (_barBtn.parentNode) _barBtn.parentNode.insertBefore(_tabHint, _barBtn);
              else _lpMd.appendChild(_tabHint);
            }
            _barBtn.style.background='#EDEDED';
            _barBtn.style.color='#3D3D3D';
            _barBtn.style.cursor='not-allowed';
            _barBtn.style.border='2px dashed #B91C1C';
            _barBtn.innerHTML='<span style="font-size:22px;">🔒</span><span style="color:#3D3D3D;">BAR LOCKED — SETTLE TABLE FIRST</span>';
            _barBtn.onclick=function(){
              try { showToast('Ask your captain to settle the table bill first','warn',2500); } catch(_){}
            };
          };
          // 🆕 2026-06-08 (Khushi) — reverse a bar lock when the table turns out to
          // be RELEASED (table doc deleted, detected by the async lookup above). The
          // sync check below may optimistically lock the bar from an open table-mode
          // round still on the cover; once we know the table is gone there is no
          // captain tab left to settle, so we unlock the bar and let the guest spend
          // any remaining wallet balance there. Runs async (after the sync lock), so
          // it cleanly restores the button. No-op if the bar was never locked.
          var _unlockBarReleased=function(reason){
            try {
              _barBtn._locked=false;
              try { console.warn('[picker] bar unlocked (table released):', reason||''); } catch(_){}
              if (_tabHint && _tabHint.parentNode) { _tabHint.parentNode.removeChild(_tabHint); }
              _tabHint=null;
              _barBtn.style.background='rgba(123,47,190,.15)';
              _barBtn.style.color='#000';
              _barBtn.style.cursor='pointer';
              _barBtn.style.border='1.5px solid rgba(123,47,190,.5)';
              _barBtn.innerHTML='<span style="font-size:22px;">🍸</span><span>I\'M AT THE BAR</span>';
              _barBtn.onclick=function(){ _lpOv.remove(); _parkOrderForBartender('customer_self_order_bar'); };
            } catch(_){}
          };
          // 🆕 2026-06-08 (Khushi) — ONE-TIME "table session ended" popup. The moment
          // a DEFINITIVE release is detected (table doc deleted, or a dead status), we
          // REPLACE the picker with a clean, friendly message and a single "SHOW QR TO
          // BARTENDER" action — no more confusing greyed table button next to a locked
          // bar. We also persist the per-booking ack flag so EVERY later order taps
          // straight through to the bartender (the picker is skipped entirely). Only
          // called from definitive-release paths — never from a phone-mismatch or a
          // read timeout (those stay fail-open / grey, never trapping a live guest).
          var _showSessionEndedPopup=function(reason){
            try {
              if (_lpOv._ended) return; _lpOv._ended=true;
              try { localStorage.setItem(_endedAckKey,'1'); } catch(_){}
              try { console.warn('[picker] session ended popup:', reason||''); } catch(_){}
              _lpMd.innerHTML=''
                +'<div style="font-size:46px;margin-bottom:10px;line-height:1;">🍸</div>'
                +'<div style="font-family:var(--ff);font-size:21px;font-weight:900;color:#000;margin-bottom:8px;letter-spacing:.3px;">Your table session has ended</div>'
                +'<div style="font-size:13px;color:#3D3D3D;line-height:1.6;margin-bottom:18px;">No problem — your wallet still works at the <b style="color:#000;">bar</b>.<br>Just show your QR to the bartender to place your order.</div>';
              var _goBar=document.createElement('button');
              _goBar.style.cssText='width:100%;padding:18px;border-radius:8px;background:rgba(123,47,190,.15);border:2px solid #7B2FBE;color:#000;font-size:15px;font-weight:900;cursor:pointer;font-family:var(--ff);margin-bottom:12px;letter-spacing:.3px;display:flex;align-items:center;justify-content:center;gap:10px;';
              _goBar.innerHTML='<span style="font-size:22px;">🍸</span><span>SHOW QR TO BARTENDER</span>';
              _goBar.onclick=function(){ try{_lpOv.remove();}catch(_){} _parkOrderForBartender('customer_self_order_bar'); };
              _lpMd.appendChild(_goBar);
              var _cc=document.createElement('button');
              _cc.style.cssText='width:100%;padding:12px;border-radius:8px;background:rgba(0,0,0,.06);border:1px solid rgba(0,0,0,.14);color:#3D3D3D;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--ff);';
              _cc.textContent='Cancel';
              _cc.onclick=function(){ try{_lpOv.remove();}catch(_){} };
              _lpMd.appendChild(_cc);
            } catch(_){}
          };
          // Sync check (cv.tabRounds — covers customer-self-order rounds).
          // 🆕 2026-06-02 v3.184c (Khushi CORE FIX) — a guest already IN BAR mode
          // keeps INSTANT-redeeming at the bar; their OWN bar rounds must NOT
          // lock the bar (they were just charged). Only an open TABLE-mode round
          // (a tab the captain settles at the END) should force "settle first".
          // Bar rounds are tagged source 'customer_self_order_bar'/'recharge_at_bar'
          // (see _parkOrderForBartender); table-mode self-orders have no/other
          // source. Captain rounds on the linked table doc still lock via the
          // async stale-check above (unchanged).
          var _isBarRound=function(r){
            var s=String((r&&r.source)||'').toLowerCase();
            return s.indexOf('bar')!==-1; // customer_self_order_bar, recharge_at_bar
          };
          var _hasOpenTableRoundsFn=function(arr){
            try {
              return Array.isArray(arr) && arr.some(function(r){
                if(!r) return false;
                var st=String(r.status||'').toLowerCase();
                var open=(st==='preparing'||st==='activated'||st==='served');
                return open && !_isBarRound(r);
              });
            } catch(_){ return false; }
          };
          // 🆕 2026-06-08 v3.217 (Khushi) — a guest who picked "I'M AT THE BAR"
          // (cv.atBar===true, set by _parkOrderForBartender, cleared the moment
          // they pick "I'M AT MY TABLE") must NEVER be bar-locked by their OWN
          // rounds — even if an older bar round lost its 'bar' source tag and
          // looks like a table round. Only a genuine TABLE-mode guest gets the
          // sync lock. Captain-placed rounds on the linked table doc still lock
          // via the async stale-check above (that's a real double-spend guard).
          if (cv.atBar!==true && _hasOpenTableRoundsFn(cv.tabRounds)) _lockBarForOpenTab('open table-mode round');
          _lpMd.appendChild(_barBtn);
          var _lpCloseBtn=document.createElement('button');
          _lpCloseBtn.style.cssText='width:100%;padding:10px;border-radius:8px;background:transparent;border:2px solid #000;color:#666;font-size:12px;cursor:pointer;font-family:var(--ff);';
          _lpCloseBtn.textContent='Cancel';
          _lpCloseBtn.onclick=function(){_lpOv.remove();};
          _lpMd.appendChild(_lpCloseBtn);
          _lpOv.appendChild(_lpMd);
          document.body.appendChild(_lpOv);
          return;
        }

        // Block if order exceeds wallet balance — ONLY in BAR / instant-
        // redemption mode. 🆕 2026-06-02 v3.183 (Khushi CORE FIX): in TABLE
        // mode (a table is attached) orders accrue as a tab and the CAPTAIN
        // settles the bill at the END, so we must NEVER block on balance there.
        // Pure covers (dance floor, no table) are always instant-redemption →
        // still gated.
        //
        // 🆕 2026-06-02 v3.194 (Khushi BUG — Aditya) — DROPPED the
        // `&& cv.atBar !== true` condition. The durable `atBar` flag is set when
        // a guest taps "I'M AT THE BAR" and STAYS true (sticky). But the bar/
        // table CHOICE popup ("WHERE ARE YOU?") appears AFTER this pre-order
        // gate. So a table guest who chose BAR in round 1 (balance → 0) had
        // atBar:true carried into round 2 → this gate fired the RECHARGE popup
        // BEFORE he could even pick TABLE again. A table-attached wallet must
        // ALWAYS be allowed to order (accrue the tab) and then route via the
        // WHERE-ARE-YOU popup: TABLE → captain notified; BAR → bartender QR,
        // and BarMode/recharge-at-bar handles any shortfall bartender-side.
        // Pure covers (no table) are unaffected — still gated.
        var _hasTableForGate = !!(cv.isTableBooking || cv.linkedTableRef || cv.tableId);
        var _inTableMode = _hasTableForGate;
        if(!_inTableMode){
          var pendingTotalRaw=tabRounds.filter(function(r){return r.status==='preparing';}).reduce(function(s,r){return s+(r.roundTotal||0);},0);
          // 🔴 2026-05-20 (Khushi Bug 2 fallback, architect-narrowed) — clamp
          // pendingTotal to bal. Captain's redeemFromWalletAtTable now marks
          // preparing rounds as "served" in the same transaction that debits
          // coverBalance — this clamp is belt-and-suspenders for LEGACY
          // wallets written before that fix shipped (and for transient
          // mid-settle states). Use Math.min so we never go negative AND
          // never under-block: if real pending exceeds balance we still cap
          // at `bal` so the next order is blocked unless ct<=0. Telemetry:
          // log when clamp fires so we can spot real issues vs legacy stale.
          var pendingTotal=Math.min(pendingTotalRaw,bal);
          if(pendingTotalRaw>bal){try{console.warn('[wallet-clamp] pendingTotalRaw',pendingTotalRaw,'>bal',bal,'— capped to bal');}catch(_){}}
          if((ct+pendingTotal)>bal){
            // Show clear popup
            var _ov=document.createElement('div');
            _ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(6px);';
            var _md=document.createElement('div');
            // 🟢 2026-06-02 v3.183 (Khushi) — RECHARGE card restyle. GREEN box,
            // NO ⚠️, NO red. Minimal copy. Quick-recharge preset chips REMOVED.
            // Two ways to add funds: PAY ONLINE (Razorpay) OR RECHARGE AT BAR
            // (parks the order so the bartender sees it on scan/search).
            _md.style.cssText='background:#fff;border:2px solid #000;border-radius:8px;padding:28px 24px;width:100%;max-width:360px;text-align:center;box-shadow:6px 6px 0 #23A094;';
            var _shortfall=ct+pendingTotal-bal;
            _md.innerHTML='<div style="font-size:20px;font-weight:900;color:#16A34A;letter-spacing:.3px;line-height:1.3;margin-bottom:8px;">RECHARGE OF ₹'+_shortfall.toLocaleString('en-IN')+' REQUIRED</div>'
              +'<div style="font-size:13px;color:#3D3D3D;line-height:1.6;margin-bottom:18px;">Tap the recharge button below.</div>';
            // Amount to recharge — defaults to the EXACT shortfall (editable).
            var _selRcAmt=Math.max(1,_shortfall);
            var _modalCustomWrap=document.createElement('div');
            _modalCustomWrap.style.cssText='margin:0 0 14px;';
            var _modalCustomRow=document.createElement('div');
            _modalCustomRow.style.cssText='display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:8px;border:2px solid #23A094;background:rgba(0,200,100,.06);';
            _modalCustomRow.innerHTML='<span style="font-family:var(--ff);font-size:16px;font-weight:900;color:#00C864;">₹</span>';
            var _modalCustomInput=document.createElement('input');
            _modalCustomInput.type='number';_modalCustomInput.min='1';_modalCustomInput.max='50000';_modalCustomInput.step='1';
            _modalCustomInput.value=String(_selRcAmt);
            _modalCustomInput.style.cssText='flex:1;background:transparent;border:none;outline:none;color:#000;font-family:var(--ff);font-size:16px;font-weight:900;width:100%;';
            _modalCustomInput.oninput=function(){
              var v=parseInt(_modalCustomInput.value,10);
              if(isNaN(v)||v<1){_modalCustomRow.style.borderColor='rgba(239,68,68,.4)';return;}
              if(v>50000){_modalCustomInput.value='50000';v=50000;}
              _modalCustomRow.style.borderColor='rgba(0,200,100,.5)';
              _selRcAmt=v;
            };
            _modalCustomRow.appendChild(_modalCustomInput);
            _modalCustomWrap.appendChild(_modalCustomRow);
            _md.appendChild(_modalCustomWrap);
            // PAY ONLINE (Razorpay) — server-verified recharge (existing path).
            var _rcPayBtn2=document.createElement('button');
            _rcPayBtn2.style.cssText='width:100%;padding:14px;border-radius:12px;background:#FF90E8;border:2px solid #000;color:#000000;font-size:14px;font-weight:900;cursor:pointer;font-family:var(--ff);margin-bottom:10px;letter-spacing:.4px;';
            _rcPayBtn2.textContent='💳 PAY ONLINE & ORDER';
            _rcPayBtn2.onclick=function(){
              if(!_selRcAmt){showToast('Enter an amount','err',2000);return;}
              _rcPayBtn2.disabled=true;_rcPayBtn2.textContent='Opening payment...';
              var _coverRef4=(cv.bookingId||cv.ref||'').replace(/[^a-zA-Z0-9_-]/g,'_');
              hodPayAndCredit({
                amount:_selRcAmt, coverRef:_coverRef4, kind:'topup',
                name:cv.name||'', phone:cv.phone||'',
                description:'Wallet Recharge ₹'+_selRcAmt, payBtn:_rcPayBtn2,
                onSuccess:function(newBalance){
                  _ov.remove();
                  showToast('✅ Recharged ₹'+_selRcAmt+'! Place your order now.','success',4000);
                },
                onError:function(msg){
                  _ov.remove();
                  showToast('⚠️ '+msg,'err',10000);
                },
                onClose:function(){_rcPayBtn2.disabled=false;_rcPayBtn2.textContent='💳 PAY ONLINE & ORDER';}
              });
            };
            _md.appendChild(_rcPayBtn2);
            // 🆕 RECHARGE AT BAR — park the order so the bartender sees it on
            // scan/search and recharges + serves at the bar.
            var _rcBarBtn=document.createElement('button');
            _rcBarBtn.style.cssText='width:100%;padding:14px;border-radius:12px;background:rgba(123,47,190,.18);border:1.5px solid rgba(123,47,190,.55);color:#000;font-size:14px;font-weight:900;cursor:pointer;font-family:var(--ff);margin-bottom:14px;letter-spacing:.3px;display:flex;align-items:center;justify-content:center;gap:8px;';
            _rcBarBtn.innerHTML='<span style="font-size:18px;">🍸</span><span>RECHARGE AT BAR</span>';
            _rcBarBtn.onclick=function(){
              _ov.remove();
              _parkOrderForBartender('recharge_at_bar');
            };
            _md.appendChild(_rcBarBtn);
            var _cb=document.createElement('button');
            _cb.style.cssText='width:100%;padding:12px;border-radius:8px;background:rgba(0,0,0,.06);border:1px solid rgba(0,0,0,.12);color:#3D3D3D;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--ff);';
            _cb.textContent='Close';
            _cb.onclick=function(){_ov.remove();};
            _md.appendChild(_cb);_ov.appendChild(_md);
            _ov.onclick=function(e){if(e.target===_ov)_ov.remove();};
            document.body.appendChild(_ov);
            return;
          }
        }
        if(placeBtn.disabled)return;
        placeBtn.disabled=true;placeBtn.textContent='Placing...';
        // 🆕 2026-06-02 v3.196 (Khushi BUG — Aditya) — CAPTURE the location choice
        // SYNCHRONOUSLY. The _lpOv picker's TABLE button does
        // `placeBtn._loc='table'; placeBtn.onclick(); finally{ placeBtn._loc=null }`
        // — so by the time the ASYNC firestore .then() below fires, placeBtn._loc
        // is already null. Snapshot it now so the post-place routing knows the
        // guest chose TABLE (skip the duplicate "WHERE ARE YOU?" popup + keep the
        // order off the bartender dashboard).
        var _chosenLoc=placeBtn._loc;
        var _isTableChoice=(_chosenLoc==='table');
        var roundItems=Object.values(cart).map(function(it){return {n:it.n,p:it.p,qty:it.qty,cat:it.cat,t:it.t||"drink",alc:it.alc===false?false:(it.t==="food"?false:true)};});
        var newRound={roundNum:getRoundNum(),items:roundItems,roundTotal:ct,status:'preparing',placedAt:new Date().toISOString()};
        // Tag a TABLE self-order so the bartender side never surfaces it as a
        // bar pre-order (captain owns it). Mirrors the source already written on
        // the tableReservations copy below.
        if(_isTableChoice)newRound.source='customer_self_order';
        var coverDocId=(cv.bookingId||cv.ref||'').replace(/[^a-zA-Z0-9_-]/g,'_');
        // Auto-mark previous activated rounds as served (customer ordering again = they got their last order)
        var updatedRounds=tabRounds.map(function(r){
          if(r.status==='activated')return Object.assign({},r,{status:'served',servedAt:new Date().toISOString()});
          return r;
        }).concat([newRound]);
        var _coverPatch={
          tabRounds:updatedRounds,tabTotal:getTabTotal()+ct,
          ref:cv.ref||cv.bookingId||'',name:cv.name||'',phone:cv.phone||'',
          isTableBooking:!!cv.isTableBooking,tableId:cv.tableId||'',floorLabel:cv.floorLabel||''
        };
        // 🆕 2026-06-02 v3.196 — guest is at the TABLE → the captain serves this
        // round. CLEAR any sticky BAR markers left by a previous round's "I'M AT
        // THE BAR" choice (atBar / hasIncomingCustomerOrder are durable) so this
        // table order does NOT ALSO light up the bartender's incoming dashboard.
        if(_isTableChoice){_coverPatch.atBar=false;_coverPatch.hasIncomingCustomerOrder=false;}
        firestore.collection('covers').doc(coverDocId).set(_coverPatch,{merge:true}).then(function(){
          tabRounds=updatedRounds;
          // 🔴 2026-05-20 (Khushi Bug 1 fix) — AUTO-IMPORT customer's self-
          // order onto the captain's running tab.
          // Before: customer placed soup → only landed on the cover wallet.
          //         Captain saw the 🔔 ping, tapped ✓ ON IT, then had to
          //         manually re-key the soup via ADD ORDER (lost context).
          // Now: if this wallet was created via door's COVER+TABLE flow
          // (cv.linkedTableRef = the tableReservations doc id), we ALSO
          // append the round to that doc's tabRounds + bump tabTotal by
          // the raw subtotal `ct`. Captain's bill card and rounds list
          // both show the item instantly. KOT print still requires the
          // captain to tap (anti-fraud — kitchen doesn't print uncontrolled).
          // We tag source:'customer_self_order' so future captain UI can
          // pill those rounds for clarity.
          // 🛟 FALLBACK: best-effort try/catch. If the write fails (rules
          // change / network blip), the cover wallet still has the round
          // and the existing 🔔 CUSTOMER CALLING banner still fires —
          // captain can fall back to manual ADD ORDER like before. Zero
          // regression for pure-cover (non-linked) wallets.
          try {
            if (cv && cv.linkedTableRef) {
              var _fv = (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue);
              var _autoRound = Object.assign({}, newRound, { source:'customer_self_order' });
              var _patch = { tabRounds: (_fv ? _fv.arrayUnion(_autoRound) : updatedRounds) };
              if (_fv) { _patch.tabTotal = _fv.increment(ct); }
              firestore.collection('tableReservations').doc(cv.linkedTableRef)
                .update(_patch)
                .catch(function(err){ try { console.warn('[auto-import] tableReservations update failed', err && err.message); } catch(_){} });
            }
          } catch (_e) {}
          var placedItems=Object.values(cart).map(function(it){return it.qty+'× '+it.n;}).join(', ');
          var placedItemsArr=Object.values(cart).map(function(it){return {n:it.n,qty:it.qty,p:it.p};});
          cart={};
          updateCartBar();
          renderRoundsHistory();
          placeBtn.disabled=false;placeBtn.textContent=cv.isTableBooking?'🍽️  Place Order':'🍹 Place Order';

          if(cv.isTableBooking){
            // TABLE BOOKING: friendly modal popup (Khushi spec 2026-05-13)
            var tbOv=document.createElement('div');
            tbOv.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(8px);animation:fadeIn .25s ease;';
            var tbMd=document.createElement('div');
            tbMd.style.cssText='background:#F4F4F0;border:2px solid #000;border-radius:8px;padding:30px 26px 22px;width:100%;max-width:380px;text-align:center;position:relative;box-shadow:0 24px 60px rgba(0,0,0,.7),0 0 40px rgba(242,199,68,.15);';
            tbMd.innerHTML=
              '<div style="font-size:54px;margin-bottom:10px;line-height:1;">🍽️</div>'
              +'<div style="font-family:var(--ff);font-size:22px;font-weight:800;color:#000;margin-bottom:8px;letter-spacing:.3px;">Order Placed!</div>'
              +'<div style="font-size:14px;color:#000;line-height:1.55;margin-bottom:18px;">Your captain has been notified and will be with you shortly to confirm.</div>'
              +'<div style="background:rgba(242,199,68,.06);border:2px solid #000;border-radius:12px;padding:12px 14px;margin-bottom:18px;">'
                +'<div style="font-size:10px;font-weight:800;color:#888;letter-spacing:1.2px;margin-bottom:6px;">YOUR ORDER</div>'
                +'<div style="font-size:13px;color:#000;font-weight:700;line-height:1.5;">'+sanitize(placedItems)+'</div>'
                +'<div style="font-size:18px;font-weight:900;color:#000;margin-top:8px;font-family:var(--ff);">₹'+ct.toLocaleString('en-IN')+'</div>'
              +'</div>'
              +'<div style="font-size:11px;color:#666;margin-bottom:14px;line-height:1.5;">Order more anytime — settle the full bill when you\'re done.</div>';
            var tbClose=document.createElement('button');
            tbClose.style.cssText='width:100%;padding:13px;border-radius:12px;background:#FF90E8;border:2px solid #000;color:#000;font-family:var(--ff);font-size:14px;font-weight:900;letter-spacing:.6px;cursor:pointer;text-transform:uppercase;';
            tbClose.textContent='Got it ✓';
            tbClose.onclick=function(){tbOv.remove();};
            tbMd.appendChild(tbClose);
            tbOv.appendChild(tbMd);
            tbOv.onclick=function(e){if(e.target===tbOv)tbOv.remove();};
            document.body.appendChild(tbOv);
          } else {
            // 🆕 2026-05-20 (Khushi spec) — LINKED-TABLE WALLET CHOICE.
            // If this wallet was created via door's "ACTIVATE COVER + TABLE"
            // flow (cv.linkedTableRef set), the customer might be at the
            // bar OR sitting at their table waiting for captain. Show a
            // 2-button "WHERE ARE YOU?" popup:
            //   🍺 AT BAR  → existing QR popup (bartender redeems)
            //   🍽 AT TABLE → write customerCallRequest on the linked
            //                 tableReservations doc → captain tablet
            //                 pulses red "🔔 CUSTOMER CALLING".
            // 🛟 FALLBACK: if linkedTableRef write fails or the field is
            // missing, fall straight through to the bartender QR (existing
            // safe path). Customer can always walk to bar / wave captain.
            var _linkedTblRef = cv.linkedTableRef || '';
            var _linkedTblId  = cv.linkedTableId  || '';
            var _linkedFloor  = cv.linkedFloorLabel || '';
            var _placedItemsStr = placedItems;
            var _placedTotal = ct;
            var _showBartenderQR = function(forceBar){
            // (function-wrapped existing bartender QR popup — invoked
            //  either directly for non-linked wallets, or via the AT BAR
            //  button below for linked-table wallets.)
            // 🆕 2026-05-27 v3.46 (Khushi LIVE-NIGHT) — table bookings must
            // ALWAYS see "captain" copy in the order-placed popup; bartenders
            // never take orders for tables (Bar Mode hard-rejects them
            // per v3.42). _staffWord/_staffLabel swap copy at the source.
            // 🆕 2026-06-02 v3.180 (Khushi BUG) — EXCEPTION: when the guest has
            // EXPLICITLY tapped "I'M AT THE BAR" (forceBar=true), show BARTENDER
            // copy — they chose the bar, and BarMode now accepts atBar covers.
            var _isTbl = !!cv.isTableBooking && !forceBar;
            var _staffWord = _isTbl ? 'captain' : 'bartender';
            var _staffLabel = _isTbl ? 'CAPTAIN REDEEM' : 'BARTENDER REDEEM';
            var overlay=document.createElement('div');
            overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(6px);font-family:var(--ff);';
            var modal=document.createElement('div');
            modal.style.cssText='background:#fff;border:2px solid #000;border-radius:8px;padding:18px 18px 14px;width:100%;max-width:380px;color:#000;box-shadow:0 12px 40px rgba(0,0,0,.6);';
            modal.innerHTML=
               '<div style="text-align:center;border-bottom:1px dashed rgba(0,0,0,.2);padding-bottom:10px;margin-bottom:12px;">'
              +  '<div style="font-family:var(--ff);font-size:18px;font-weight:900;color:#000;letter-spacing:1px;">HOUSE OF DOPAMINE</div>'
              +  '<div style="font-size:10px;color:#3D3D3D;margin-top:2px;letter-spacing:.6px;">ORDER PLACED · '+_staffLabel+'</div>'
              +'</div>'
              +'<div style="text-align:center;font-size:16px;color:#000;margin-bottom:14px;line-height:1.6;font-weight:600;">Show this QR to your <strong style="background:#FF90E8;color:#000;padding:1px 7px;border-radius:5px;border:1.5px solid #000;">'+_staffWord+'</strong> to prepare your order</div>'
              +'<div style="background:#fff;border:2px solid #000;border-radius:14px;padding:14px;margin:0 auto 12px;width:max-content;box-shadow:4px 4px 0 #000;"><div id="order-qr-popup" style="width:160px;height:160px;background:#fff;border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden;"></div></div>'
              +'<div style="text-align:center;font-family:monospace;font-size:12px;color:#000;letter-spacing:2px;margin-bottom:12px;">'+sanitize(cv.ref||cv.bookingId||'')+'</div>'
              +'<div style="padding:4px 0 6px;margin-bottom:10px;">'
              +  '<div style="font-size:10px;color:#3D3D3D;letter-spacing:.6px;text-transform:uppercase;margin-bottom:8px;text-align:center;font-weight:800;">Your Order</div>'
              +  placedItemsArr.map(function(it){return '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;background:#F4F4F0;border:2px solid #000;border-radius:8px;padding:9px 12px;margin-bottom:8px;box-shadow:3px 3px 0 #000;"><span style="font-size:13px;color:#000;font-weight:700;">'+it.qty+'× '+sanitize(it.n)+'</span><span style="font-size:13px;color:#000;font-weight:800;white-space:nowrap;">\u20b9'+((it.p||0)*(it.qty||0)).toLocaleString('en-IN')+'</span></div>';}).join('')
              +'</div>'
              +'<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0 10px;">'
              +  '<span style="font-size:13px;font-weight:900;color:#000;">Total</span>'
              +  '<span style="font-family:var(--ff);font-size:20px;font-weight:900;color:#000;font-variant-numeric:tabular-nums;">\u20b9'+ct.toLocaleString('en-IN')+'</span>'
              +'</div>'
              +'<div style="text-align:center;font-size:14px;color:#000;margin-bottom:14px;line-height:1.6;font-weight:700;">'+(_isTbl?'Captain':'Bartender')+' will scan, confirm and <strong style="background:#FF90E8;color:#000;padding:1px 7px;border-radius:5px;border:1.5px solid #000;">deduct</strong> from your wallet automatically</div>';
            var closeBtn=document.createElement('button');
            closeBtn.style.cssText='width:100%;padding:14px;border-radius:10px;background:#FF90E8;border:2px solid #000;color:#000;font-size:14px;font-weight:900;cursor:pointer;font-family:var(--ff);letter-spacing:.6px;text-transform:uppercase;box-shadow:4px 4px 0 #000;';
            closeBtn.textContent='Got it ✓';
            closeBtn.onclick=function(){overlay.remove();};
            modal.appendChild(closeBtn);
            overlay.appendChild(modal);
            overlay.onclick=function(e){if(e.target===overlay)overlay.remove();};
            document.body.appendChild(overlay);
            // Generate QR
            setTimeout(function(){generateLocalQR('order-qr-popup','https://hodclub.in/?verify='+(cv.ref||cv.bookingId||'')+'');},100);
            }; // end _showBartenderQR

            // 🆕 2026-05-20 — branch on linkedTableRef.
            // If wallet is NOT linked to a table → straight to bartender QR
            // (unchanged behaviour for walk-in covers / event tickets).
            // We REQUIRE linkedTableRef (the actual Firestore doc id) — if
            // only linkedTableId (the human-readable "F-12") is present
            // without a doc ref, we can't write the ping anywhere, so fall
            // through to bartender QR. (Architect note 2026-05-20.)
            if(_isTableChoice && _linkedTblRef){
              // 🆕 2026-06-02 v3.196 (Khushi BUG — Aditya) — the guest ALREADY
              // told us "I'M AT MY TABLE" in the pre-place _lpOv picker
              // (_chosenLoc==='table'). Re-showing the chOv "WHERE ARE YOU?"
              // popup here was a CONFUSING DOUBLE popup (pick table → asked
              // again). Ping the captain DIRECTLY and show a single CAPTAIN
              // NOTIFIED card. Fail-open: on write error, fall back to the
              // bartender QR so the guest always has a path.
              var _tnOv=document.createElement('div');
              _tnOv.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(8px);font-family:var(--ff);';
              var _tnMd=document.createElement('div');
              _tnMd.style.cssText='background:#F4F4F0;border:2px solid #000;border-radius:8px;padding:26px 22px 20px;width:100%;max-width:380px;text-align:center;color:#000;box-shadow:0 24px 60px rgba(0,0,0,.7),0 0 40px rgba(242,199,68,.15);';
              _tnMd.innerHTML='<div style="font-size:48px;margin-bottom:10px;line-height:1;">⏳</div>'
                +'<div style="font-family:var(--ff);font-size:20px;font-weight:900;color:#000;letter-spacing:.4px;">CALLING CAPTAIN…</div>';
              _tnOv.appendChild(_tnMd);
              document.body.appendChild(_tnOv);
              firestore.collection('tableReservations').doc(_linkedTblRef).update({
                customerCallRequest:{
                  at:new Date().toISOString(),
                  itemsPreview:_placedItemsStr,
                  total:_placedTotal
                }
              }).then(function(){
                _tnMd.innerHTML=
                   '<div style="font-size:54px;margin-bottom:10px;line-height:1;">🔔</div>'
                  +'<div style="font-family:var(--ff);font-size:22px;font-weight:900;color:#23A094;margin-bottom:8px;letter-spacing:.3px;">CAPTAIN NOTIFIED!</div>'
                  +'<div style="font-size:13px;color:#3D3D3D;line-height:1.6;margin-bottom:18px;">Your captain has been pinged and will be at <strong style="color:#000;">'+sanitize(_linkedTblId||'your table')+'</strong> shortly.<br><span style="color:#B0B0B0;font-size:11px;">Sit tight, enjoy the music 🎶</span></div>';
                var _tnOk=document.createElement('button');
                _tnOk.style.cssText='width:100%;padding:13px;border-radius:8px;background:#FF90E8;border:2px solid #000;color:#000;font-size:14px;font-weight:900;letter-spacing:.6px;cursor:pointer;text-transform:uppercase;font-family:var(--ff);box-shadow:3px 3px 0 #000;';
                _tnOk.textContent='Got it ✓';
                _tnOk.onclick=function(){_tnOv.remove();};
                _tnMd.appendChild(_tnOk);
              }).catch(function(err){
                _tnOv.remove();
                showToast('⚠️ Could not reach captain — show QR to bartender or wave for service.','err',5000);
                _showBartenderQR();
              });
            } else if(!_linkedTblRef){
              _showBartenderQR();
            } else {
              // LINKED-TABLE WALLET → "WHERE ARE YOU?" 2-button popup.
              var chOv=document.createElement('div');
              chOv.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(8px);font-family:var(--ff);';
              var chMd=document.createElement('div');
              chMd.style.cssText='background:#F4F4F0;border:2px solid #000;border-radius:8px;padding:26px 22px 20px;width:100%;max-width:380px;text-align:center;color:#000;box-shadow:0 24px 60px rgba(0,0,0,.7),0 0 40px rgba(242,199,68,.15);';
              chMd.innerHTML=
                 '<div style="font-size:46px;margin-bottom:10px;line-height:1;">📍</div>'
                +'<div style="font-family:var(--ff);font-size:20px;font-weight:900;color:#000;margin-bottom:6px;letter-spacing:.4px;">WHERE ARE YOU?</div>'
                +'<div style="font-size:13px;color:#aaa;line-height:1.55;margin-bottom:18px;">Your order of <strong style="color:#000;">₹'+_placedTotal.toLocaleString('en-IN')+'</strong> is in.<br>Tell us where to bring it.</div>'
                +'<div style="background:rgba(242,199,68,.06);border:1px dashed rgba(242,199,68,.25);border-radius:8px;padding:10px 12px;margin-bottom:18px;font-size:12px;color:#888;line-height:1.5;">'
                +  '<div style="font-size:10px;font-weight:800;color:#888;letter-spacing:1.2px;margin-bottom:4px;">YOUR TABLE</div>'
                +  '<div style="font-size:14px;color:#000;font-weight:800;">'+sanitize(_linkedTblId||'-')+(_linkedFloor?' · '+sanitize(_linkedFloor):'')+'</div>'
                +'</div>';
              // 🍺 AT BAR button → existing bartender QR popup
              var barBtn=document.createElement('button');
              barBtn.style.cssText='width:100%;padding:18px 14px;border-radius:8px;background:#FF90E8;border:2px solid #000;color:#000;font-family:var(--ff);font-size:15px;font-weight:900;letter-spacing:.8px;cursor:pointer;text-transform:uppercase;margin-bottom:10px;box-shadow:0 4px 14px rgba(242,199,68,.25);';
              barBtn.innerHTML='🍺 I\'M AT THE BAR<div style="font-size:10px;font-weight:700;opacity:.7;letter-spacing:.4px;text-transform:none;margin-top:3px;">Show QR to bartender</div>';
              barBtn.onclick=function(){
                chOv.remove();
                // 🆕 2026-06-02 v3.180 (Khushi BUG) — explicit bar choice → set
                // the durable atBar flag so BarMode lets the bartender open this
                // table booking's wallet on SCAN. Fire-and-forget + fail-open:
                // the QR popup shows regardless of the write result.
                try {
                  var _abId=(cv.bookingId||cv.ref||'').replace(/[^a-zA-Z0-9_-]/g,'_');
                  if(firestore&&_abId){firestore.collection('covers').doc(_abId).set({atBar:true,atBarAt:new Date().toISOString()},{merge:true}).catch(function(){});}
                } catch(_eAB){}
                _showBartenderQR(true);
              };
              chMd.appendChild(barBtn);
              // 🍽 AT TABLE button → ping captain
              var tblBtn=document.createElement('button');
              tblBtn.style.cssText='width:100%;padding:18px 14px;border-radius:8px;background:#23A094;border:2px solid #000;color:#fff;font-family:var(--ff);font-size:15px;font-weight:900;letter-spacing:.8px;cursor:pointer;text-transform:uppercase;margin-bottom:10px;box-shadow:3px 3px 0 #000;';
              tblBtn.innerHTML='🍽 I\'M AT MY TABLE<div style="font-size:10px;font-weight:700;opacity:.85;letter-spacing:.4px;text-transform:none;margin-top:3px;">Captain will come to you</div>';
              tblBtn.onclick=function(){
                tblBtn.disabled=true;
                tblBtn.innerHTML='Calling captain...';
                // 🆕 2026-06-02 v3.180 (Khushi BUG, architect note) — guest is
                // back on the TABLE path → clear any stale atBar so the bartender
                // can't still open this wallet from an earlier bar choice. Fire-
                // and-forget + fail-open (never blocks the captain ping).
                try {
                  var _atId=(cv.bookingId||cv.ref||'').replace(/[^a-zA-Z0-9_-]/g,'_');
                  if(firestore&&_atId){firestore.collection('covers').doc(_atId).set({atBar:false,atTableAt:new Date().toISOString()},{merge:true}).catch(function(){});}
                } catch(_eAT){}
                // Write customerCallRequest on the linked tableReservations doc.
                // Fail-open: if this errors, fall back to bartender QR + show
                // a hint so the customer still has a path.
                firestore.collection('tableReservations').doc(_linkedTblRef).update({
                  customerCallRequest:{
                    at:new Date().toISOString(),
                    itemsPreview:_placedItemsStr,
                    total:_placedTotal
                  }
                }).then(function(){
                  chMd.innerHTML=
                     '<div style="font-size:54px;margin-bottom:10px;line-height:1;">🔔</div>'
                    +'<div style="font-family:var(--ff);font-size:22px;font-weight:900;color:#23A094;margin-bottom:8px;letter-spacing:.3px;">CAPTAIN NOTIFIED!</div>'
                    +'<div style="font-size:13px;color:#aaa;line-height:1.6;margin-bottom:18px;">Your captain has been pinged and will be at <strong style="color:#000;">'+sanitize(_linkedTblId||'your table')+'</strong> shortly.<br><span style="color:#666;font-size:11px;">Sit tight, enjoy the music 🎶</span></div>';
                  var ok=document.createElement('button');
                  ok.style.cssText='width:100%;padding:13px;border-radius:12px;background:#FF90E8;border:2px solid #000;color:#000;font-size:14px;font-weight:900;letter-spacing:.6px;cursor:pointer;text-transform:uppercase;font-family:var(--ff);';
                  ok.textContent='Got it ✓';
                  ok.onclick=function(){chOv.remove();};
                  chMd.appendChild(ok);
                }).catch(function(err){
                  // Fallback — show bartender QR + a small hint
                  chOv.remove();
                  showToast('⚠️ Could not reach captain — show QR to bartender or wave for service.','err',5000);
                  _showBartenderQR();
                });
              };
              chMd.appendChild(tblBtn);
              // Close (X) — small unobtrusive
              var xBtn=document.createElement('button');
              xBtn.style.cssText='width:100%;padding:10px;border-radius:8px;background:transparent;border:2px solid #000;color:#666;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--ff);letter-spacing:.4px;text-transform:uppercase;';
              xBtn.textContent='close';
              xBtn.onclick=function(){chOv.remove();};
              chMd.appendChild(xBtn);
              chOv.appendChild(chMd);
              chOv.onclick=function(e){if(e.target===chOv)chOv.remove();};
              document.body.appendChild(chOv);
            }
          }

          if(cv.isTableBooking&&cv.ref){
            firestore.collection('tableReservations').where('bookingRef','==',cv.ref).get()
              .then(function(snap){snap.forEach(function(d){d.ref.update({tabRounds:updatedRounds,tabTotal:getTabTotal()});});})
              .catch(function(){});
          }
        }).catch(function(e){
          placeBtn.disabled=false;placeBtn.textContent=cv.isTableBooking?'🍽️  Place Order':'🍹 Place Order';
          showToast('Failed: '+e.message,'err',3000);
        });
      };

      // ── Checkout (shows full bill modal)
      checkoutBtn.onclick=function(){
        var tt=getTabTotal()+getCartTotal();
        if(!tt){showToast('Your tab is empty','err',2000);return;}
        if(getCartTotal()>0){
          if(!confirm('You have '+getCartTotal()+' unplaced items. Place them first or checkout now?'))return;
        }
        showCheckoutModal(getTabTotal());
      };

      // ── Rounds history — 2026-05-13 v3 (Khushi spec, round 8):
      // YOUR TAB now sits ABOVE the Running Tab / Place Order / Done
      // Ordering block so the bottom of the page is always the two
      // action buttons. Order: menu → YOUR TAB → RUNNING TAB +
      // PLACE ORDER + Done Ordering. (Round 5 placed YOUR TAB after
      // submitCard; Round 8 flips it via insertBefore so Place Order
      // and Done Ordering stay the last two CTAs at the page bottom.)
      var roundsSection=document.createElement('div');
      roundsSection.id='tab-rounds-history';
      roundsSection.style.cssText='margin:18px 0 24px;';
      if(submitCard&&submitCard.parentNode===inner){
        inner.insertBefore(roundsSection, submitCard);
      } else {
        inner.appendChild(roundsSection);
      }

      // 🆕 2026-05-20 (Khushi) — YOUR TAB visual overhaul.
      //  • Cream/light-gold card so DARK text on light bg = readable in
      //    bright club lighting.
      //  • BIG bold "Round 1", "Round 2" headers (16px, dark gold) with a
      //    dotted divider between rounds (matches captain BillPreview
      //    aesthetic).
      //  • Item rows: 14px dark text, tabular-num prices, served chip.
      //  • Grand total row: 22px bold + "Inclusive of all taxes" subtitle
      //    computed via hodComputeBreakdown (single source of truth — same
      //    math as captain's bill).
      //  • 🆕 "VIEW BILL" button that opens a modal mirroring the captain's
      //    Bill Preview (HOUSE OF DOPAMINE header, items, SC/CGST/SGST,
      //    GRAND TOTAL). Read-only — no Place Order, just CLOSE.
      function renderRoundsHistory(){
        var sec=document.getElementById('tab-rounds-history');
        if(!sec)return;
        sec.innerHTML='';
        if(!tabRounds.length)return;
        var tt=getTabTotal();
        var bd=null;
        try{
          var _all=[];
          tabRounds.forEach(function(r){(r.items||[]).forEach(function(i){_all.push(i);});});
          // 🆕 2026-06-07 — YOUR TAB grand reflects the bartender's discount/SC
          // so it matches the bar + the VIEW BILL preview. Per-round totals below
          // stay at menu price (the discount is a single bill-level line).
          bd=hodComputeBreakdown(_all, Number(cv.billDiscountPct||0), (cv.billScOn!==false));
        }catch(_e){bd=null;}
        var grand=bd?bd.grandTotal:tt;

        var hdr=document.createElement('div');
        hdr.style.cssText='background:#FFD700;border:2px solid #b89545;border-radius:8px;padding:18px 18px 16px;box-shadow:3px 3px 0 #000;color:#1a1408;font-family:var(--ff);';

        // Header row: YOUR TAB · ₹total
        var headHtml=''
          +'<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px;border-bottom:2px dashed #8a6a1f;padding-bottom:10px;">'
          +'<span style="font-size:14px;font-weight:900;color:#5c3f0a;letter-spacing:2px;">📋 YOUR TAB</span>'
          +'<span style="font-size:22px;font-weight:900;color:#1a1408;font-variant-numeric:tabular-nums;">₹'+grand+'</span>'
          +'</div>';

        var statusC={'preparing':'#a85800','activated':'#0a7a3c','served':'#0a7a3c','paid':'#0a7a3c'};
        var statusL={'preparing':'🟡 Ordered','activated':'🔵 Preparing','served':'✅ Served','paid':'💳 Paid'};

        // 🆕 2026-06-08 v3.253 (Khushi) — render rounds in true CHRONOLOGICAL order
        // (by placedAt) and RENUMBER the display label 1..N. The stored roundNum is
        // unreliable: bar / table / captain / bartender each compute it off a
        // DIFFERENT array (tabRounds.length+1) so the numbers COLLIDE ("Round 3"
        // twice) and GAP ("missing Round 2"). placedAt is the only reliable order,
        // so we sort by it and number sequentially — R1 bar → R2 bar → R3 table → …
        var _sortedRounds=tabRounds.slice().sort(function(a,b){return String((a&&a.placedAt)||'').localeCompare(String((b&&b.placedAt)||''));});
        var roundsHtml=_sortedRounds.map(function(r,idx){
          var sc=statusC[r.status]||'#5c3f0a';
          var sl=statusL[r.status]||r.status;
          var rBd=null;
          try{rBd=hodComputeBreakdown(r.items||[]);}catch(_e){rBd=null;}
          var rTotal=rBd?rBd.grandTotal:(r.roundTotal||0);
          // 🆕 2026-06-08 (Khushi) — per-round location badge so the guest sees
          // WHERE each round was placed. Now from the shared hodRoundLocBadge helper
          // (same logic the VIEW BILL modal uses), so YOUR TAB + the bill always agree.
          var _locBadge=hodRoundLocBadge(r);
          var ilist=(r.items||[]).map(function(it){
            return '<div style="display:flex;justify-content:space-between;font-size:14px;padding:4px 0;color:#1a1408;font-weight:600;">'
              +'<span style="flex:1;padding-right:8px;">'+sanitize(it.qty+'× '+it.n)+'</span>'
              +'<span style="color:#3a2a08;font-variant-numeric:tabular-nums;font-weight:700;">₹'+(it.p*it.qty)+'</span></div>';
          }).join('');
          var sep=idx<_sortedRounds.length-1?'border-bottom:1.5px dashed #8a6a1f;':'';
          return '<div style="padding:10px 0 12px;'+sep+'">'
            +'<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;gap:8px;">'
            +'<span style="display:flex;flex-direction:column;gap:5px;min-width:0;">'
            +'<span style="font-size:17px;font-weight:900;color:#5c3f0a;letter-spacing:.5px;">● Round '+(idx+1)+'</span>'
            +(_locBadge?('<span style="display:flex;">'+_locBadge+'</span>'):'')
            +'</span>'
            +'<span style="display:flex;align-items:center;gap:8px;flex-shrink:0;">'
            +'<span style="font-size:11px;font-weight:800;color:'+sc+';background:rgba(255,255,255,.55);padding:3px 9px;border-radius:12px;letter-spacing:.4px;">'+sl+'</span>'
            +'<span style="font-size:17px;font-weight:900;color:#1a1408;font-variant-numeric:tabular-nums;">₹'+rTotal+'</span>'
            +'</span></div>'
            +ilist+'</div>';
        }).join('');

        // Inclusive-of-tax footer + VIEW BILL button
        var footHtml=''
          +'<div style="margin-top:6px;padding-top:10px;border-top:2px dashed #8a6a1f;text-align:right;font-size:12px;font-style:italic;color:#5c3f0a;font-weight:600;">Inclusive of all taxes (SC + GST)</div>'
          +'<button id="hod-view-bill-btn" type="button" style="margin-top:14px;width:100%;padding:14px;border-radius:12px;background:#000;border:2px solid #000;color:#f5e8c0;font-size:15px;font-weight:900;letter-spacing:1.2px;cursor:pointer;font-family:var(--ff);box-shadow:0 4px 14px rgba(0,0,0,.3);">📄 VIEW BILL</button>';

        hdr.innerHTML=headHtml+roundsHtml+footHtml;
        sec.appendChild(hdr);

        var vb=document.getElementById('hod-view-bill-btn');
        if(vb)vb.addEventListener('click',function(){showBillOnlyModal();});
      }
      renderRoundsHistory();

      // 🆕 2026-05-27 v3.67 (Khushi LIVE-NIGHT) — auto-open the Bill Preview
      // modal when the wallet is opened with `?bill=1` (used by the
      // post-Google-rating "VIEW BILL" CTA on the feedback card). One-shot
      // guarded so subsequent Firestore snapshot re-renders don't keep
      // popping the modal back open.
      try{
        if(!window.__hodBillAutoOpened){
          var _qs=new URLSearchParams(window.location.search||'');
          if(_qs.get('bill')==='1'){
            window.__hodBillAutoOpened=true;
            setTimeout(function(){ try{ showBillOnlyModal(); }catch(_){} },300);
          }
        }
      }catch(_){ }

      // 🆕 2026-05-20 (Khushi) — read-only Bill Preview modal for the
      // customer side. Mirrors captain CaptainMode.tsx BillPreviewModal:
      // HOD header, table/guest meta, ITEMS list, SUBTOTAL · SC · CGST ·
      // SGST · GRAND TOTAL. No Place Order — just CLOSE.
      function showBillOnlyModal(){
        if(!tabRounds.length)return;
        var allItems=[];
        tabRounds.forEach(function(r){(r.items||[]).forEach(function(i){allItems.push(i);});});
        // 🆕 2026-06-07 — honor the bartender's persisted bill-level discount + SC
        // toggle so this preview matches the bar's bill to the rupee.
        var _bDisc=Number(cv.billDiscountPct||0), _bSc=(cv.billScOn!==false);
        var bd;try{bd=hodComputeBreakdown(allItems, _bDisc, _bSc);}catch(e){bd=null;}
        if(!bd)return;
        var overlay=document.createElement('div');
        overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.85);backdrop-filter:blur(8px);z-index:10001;display:flex;align-items:center;justify-content:center;padding:16px;font-family:var(--ff);';
        var card=document.createElement('div');
        card.style.cssText='background:#FFFFFF;border:2px solid #000;border-radius:12px;max-width:480px;width:100%;max-height:92vh;overflow:auto;color:#000;';
        // 🆕 2026-06-08 (Khushi) — group the bill by ROUND with a per-round
        // location badge (🍸 bar / 🍽️ table) so the customer always sees EVERY
        // round AND where it was placed, no matter the mode. Each round renders a
        // header row (Round N + badge) followed by its items. Falls back to a flat
        // list only for the legacy case where no rounds carry items.
        var _zebra=0;
        // 🆕 2026-06-08 v3.253 (Khushi) — chronological order + sequential renumber
        // (see renderRoundsHistory). Sort by placedAt; label each rendered round with
        // a running counter (skips empty rounds) so the bill reads R1, R2, R3 … with
        // no dup/gap, instead of the unreliable stored roundNum.
        var _billRounds=tabRounds.slice().sort(function(a,b){return String((a&&a.placedAt)||'').localeCompare(String((b&&b.placedAt)||''));});
        var _billNo=0;
        var itemsRows=_billRounds.map(function(r){
          var _rItems=(r.items||[]);
          if(!_rItems.length) return '';
          _billNo++;
          var _badge=hodRoundLocBadge(r);
          var _hdr='<tr style="background:#fff;"><td colspan="3" style="padding:10px 12px 4px;border-top:1px dashed rgba(0,0,0,.12);"><span style="display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;"><span style="font-size:11px;font-weight:900;color:#000;letter-spacing:.5px;">ROUND '+_billNo+'</span>'+(_badge||'')+'</span></td></tr>';
          var _rows=_rItems.map(function(it){
            var bg=(_zebra++%2===0)?'#fff':'#F4F4F0';
            return '<tr style="background:'+bg+';"><td style="padding:8px 12px;font-size:13px;color:#3D3D3D;width:40px;">'+it.qty+'</td><td style="padding:8px 12px;font-size:13px;color:#000;">'+sanitize(it.n)+'</td><td style="padding:8px 12px;font-size:13px;font-weight:700;color:#000;text-align:right;font-variant-numeric:tabular-nums;">&#x20B9;'+Math.round((it.p||0)*(it.qty||0))+'</td></tr>';
          }).join('');
          return _hdr+_rows;
        }).join('');
        var _bpName=cv.customerName||cv.name||'—';
        var _bpPhone=cv.phone||cv.customerPhone||'';
        var _bpRef=cv.ref||cv.bookingId||'';
        var _bpWhen=[cv.date||cv.eventDate||'',cv.arrivalTime||''].filter(Boolean).join(' · ');
        var meta=''
          +(cv.tableId?'<div style="font-size:12px;color:#3D3D3D;margin-bottom:3px;"><b style="color:#000;">TABLE:</b> '+sanitize(cv.tableId)+(cv.floorLabel?' &middot; '+sanitize(cv.floorLabel):'')+'</div>':'')
          +'<div style="font-size:12px;color:#3D3D3D;margin-bottom:3px;"><b style="color:#000;">GUEST:</b> '+sanitize(_bpName)+'</div>'
          +(_bpPhone?'<div style="font-size:12px;color:#3D3D3D;margin-bottom:3px;"><b style="color:#000;">PHONE:</b> '+sanitize(_bpPhone)+'</div>':'')
          +(cv.partySize?'<div style="font-size:12px;color:#3D3D3D;margin-bottom:3px;"><b style="color:#000;">GUESTS:</b> '+sanitize(String(cv.partySize))+'</div>':'')
          +(_bpWhen?'<div style="font-size:12px;color:#3D3D3D;margin-bottom:3px;"><b style="color:#000;">WHEN:</b> '+sanitize(_bpWhen)+'</div>':'')
          +(_bpRef?'<div style="font-size:12px;color:#3D3D3D;"><b style="color:#000;">REF:</b> '+sanitize(_bpRef)+'</div>':'');
        card.innerHTML=''
          +'<div style="padding:16px 18px;border-bottom:2px solid #000;">'
          +'<div style="font-size:10px;color:#3D3D3D;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">BILL PREVIEW</div>'
          +'<div style="font-size:22px;font-weight:900;color:#000;font-family:var(--ff);">HOUSE OF DOPAMINE</div>'
          +'<div style="font-size:11px;color:#3D3D3D;margin-top:2px;">'+sanitize(cv.floorLabel||'')+'</div>'
          +'</div>'
          +'<div style="padding:12px 18px;border-bottom:1px dashed rgba(0,0,0,.1);">'+meta+'</div>'
          +'<div style="padding:12px 0;">'
          +'<table style="width:100%;border-collapse:collapse;font-family:var(--ff);">'
          +'<thead><tr style="border-bottom:2px solid #000;"><th style="padding:8px 12px;font-size:10px;font-weight:800;color:#3D3D3D;text-align:left;letter-spacing:1px;text-transform:uppercase;width:40px;">Qty</th><th style="padding:8px 12px;font-size:10px;font-weight:800;color:#3D3D3D;text-align:left;letter-spacing:1px;text-transform:uppercase;">Item</th><th style="padding:8px 12px;font-size:10px;font-weight:800;color:#3D3D3D;text-align:right;letter-spacing:1px;text-transform:uppercase;">Amount</th></tr></thead>'
          +'<tbody>'+itemsRows+'</tbody>'
          +'</table></div>'
          +'<div style="padding:12px 18px;border-top:2px solid #000;">'
          +'<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;color:#3D3D3D;"><span>Subtotal</span><span style="font-variant-numeric:tabular-nums;font-weight:600;">&#x20B9;'+Math.round((bd.foodSubtotal||0)+(bd.alcSubtotal||0)+(bd.nonAlcSubtotal||0))+'</span></div>'
          +((bd.discount||0)>0?'<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;color:#16A34A;font-weight:800;"><span>DISCOUNT ('+bd.discountPct+'%)</span><span style="font-variant-numeric:tabular-nums;">&#8722;&#x20B9;'+Math.round(bd.discount)+'</span></div>':'')
          +((bd.serviceCharge||0)>0?'<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;color:#3D3D3D;"><span>Service Charge (10%)</span><span style="font-variant-numeric:tabular-nums;font-weight:600;">&#x20B9;'+(bd.serviceCharge||0).toFixed(0)+'</span></div>':'')
          +'<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;color:#3D3D3D;"><span>CGST (2.5%)</span><span style="font-variant-numeric:tabular-nums;font-weight:600;">&#x20B9;'+((bd.gst||0)/2).toFixed(2)+'</span></div>'
          +'<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;color:#3D3D3D;"><span>SGST (2.5%)</span><span style="font-variant-numeric:tabular-nums;font-weight:600;">&#x20B9;'+((bd.gst||0)/2).toFixed(2)+'</span></div>'
          +'<div style="height:2px;background:#000;margin:10px 0;"></div>'
          +'<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:16px;font-weight:900;color:#000;"><span>GRAND TOTAL</span><span style="font-variant-numeric:tabular-nums;">&#x20B9;'+Math.round(bd.grandTotal)+'</span></div>'
          +'</div>'
          +'<div style="padding:14px;">'
          +'<button id="hod-bill-close-btn" type="button" style="width:100%;padding:14px;border-radius:8px;background:#FF90E8;border:2px solid #000;color:#000;font-size:14px;font-weight:800;letter-spacing:.5px;cursor:pointer;text-transform:uppercase;font-family:var(--ff);">CLOSE</button>'
          +'</div>';
        overlay.appendChild(card);
        function _close(){if(overlay.parentNode)overlay.parentNode.removeChild(overlay);}
        overlay.addEventListener('click',function(e){if(e.target===overlay)_close();});
        document.body.appendChild(overlay);
        var cb=document.getElementById('hod-bill-close-btn');
        if(cb)cb.addEventListener('click',_close);
      }

      // ── Checkout modal
      function showCheckoutModal(tt){
        // 🆕 2026-06-08 — the SETTLE total + Pay Online charge must match the bar +
        // YOUR TAB: recompute the whole placed tab through the SAME discount/SC-aware
        // breakdown so a 5% bar discount is honoured at settle (₹1398, not ₹1469) and
        // the guest is never charged the un-discounted menu price.
        try{
          var _stAll=[];
          (tabRounds||[]).forEach(function(r){(r.items||[]).forEach(function(i){_stAll.push(i);});});
          if(_stAll.length){tt=hodComputeBreakdown(_stAll, Number(cv.billDiscountPct||0), (cv.billScOn!==false)).grandTotal;}
        }catch(_eDt){}
        var overlay=document.createElement('div');
        overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9999;display:flex;align-items:flex-end;justify-content:center;';
        var sheet=document.createElement('div');
        sheet.style.cssText='background:rgba(244,244,240,.99);border:2px solid #000;border-radius:24px 24px 0 0;padding:28px 24px 48px;width:100%;max-width:480px;max-height:88vh;overflow-y:auto;';

        var bHtml='<div style="text-align:center;margin-bottom:20px;">'
          +'<div style="font-size:13px;font-weight:800;color:#000;letter-spacing:2px;margin-bottom:4px;">HOUSE OF DOPAMINE</div>'
          +'<div style="font-size:11px;color:#3D3D3D;">'+(cv.tableId?sanitize(cv.tableId)+' · ':'')+sanitize(cv.floorLabel||'')+'</div>'
          +'<div style="font-size:11px;color:#3D3D3D;">'+new Date().toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'})+'</div>'
          +'</div>'
          +'<div style="border-top:1px solid rgba(0,0,0,.08);padding-top:14px;margin-bottom:16px;">';

        // 🆕 2026-06-08 v3.253 (Khushi) — chronological order + sequential renumber
        // (see renderRoundsHistory) so the SETTLE breakdown matches YOUR TAB + VIEW BILL.
        var _coRounds=(tabRounds||[]).slice().sort(function(a,b){return String((a&&a.placedAt)||'').localeCompare(String((b&&b.placedAt)||''));});
        _coRounds.forEach(function(r,ci){
          bHtml+='<div style="margin-bottom:14px;">'
            +'<div style="font-size:10px;font-weight:800;color:#000;margin-bottom:6px;letter-spacing:.5px;">ROUND '+(ci+1)+'</div>';
          r.items.forEach(function(it){
            bHtml+='<div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;">'
              +'<span>'+it.qty+'× '+sanitize(it.n)+'</span>'
              +'<span style="color:#000;">₹'+(it.p*it.qty)+'</span></div>';
          });
          bHtml+='</div>';
        });

        bHtml+='</div>'
          +'<div style="display:flex;justify-content:space-between;border-top:2px solid rgba(242,199,68,.3);padding-top:14px;margin-bottom:6px;">'
          +'<span style="font-size:16px;font-weight:900;">TOTAL</span>'
          +'<span style="font-size:22px;font-weight:900;color:#000;">₹'+tt+'</span></div>';

        // 2026-05-13 (Khushi spec, round 5) — Order Total screen had no tax
        // breakdown. Add a collapsed "View tax breakdown" disclosure so
        // customers can see SC + GST split before paying.
        var _coAll=[];
        (tabRounds||[]).forEach(function(r){(r.items||[]).forEach(function(i){_coAll.push(i);});});
        // 🆕 2026-06-08 — breakdown honours the bartender's persisted discount/SC so
        // the rows reconcile to the discounted grand (matches VIEW BILL + the bar).
        var _coBd;try{_coBd=hodComputeBreakdown(_coAll, Number(cv.billDiscountPct||0), (cv.billScOn!==false));}catch(e){_coBd=null;}
        if(_coBd){
          var _coRows='';
          if(_coBd.foodSubtotal>0)    _coRows+='<div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Food subtotal</span><span>\u20B9'+_coBd.foodSubtotal.toFixed(0)+'</span></div>';
          if(_coBd.alcSubtotal>0)     _coRows+='<div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Liquor subtotal</span><span>\u20B9'+_coBd.alcSubtotal.toFixed(0)+'</span></div>';
          if(_coBd.nonAlcSubtotal>0)  _coRows+='<div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Beverages subtotal</span><span>\u20B9'+_coBd.nonAlcSubtotal.toFixed(0)+'</span></div>';
          if((_coBd.discount||0)>0)   _coRows+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#16A34A;font-weight:800;"><span>DISCOUNT ('+_coBd.discountPct+'%)</span><span>\u2212\u20B9'+Math.round(_coBd.discount)+'</span></div>';
          _coRows+='<div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Service charge (10%)</span><span>\u20B9'+_coBd.serviceCharge.toFixed(0)+'</span></div>';
          _coRows+='<div style="display:flex;justify-content:space-between;padding:2px 0;"><span>GST (5%)</span><span>\u20B9'+_coBd.gst.toFixed(0)+'</span></div>';
          if(Math.abs(_coBd.roundOff||0)>=0.01) _coRows+='<div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Round off</span><span>'+(_coBd.roundOff>=0?'+':'')+'\u20B9'+Math.abs(_coBd.roundOff).toFixed(2)+'</span></div>';
          _coRows+='<div style="display:flex;justify-content:space-between;padding:6px 0 2px;border-top:1px solid rgba(242,199,68,.2);margin-top:6px;color:#000;font-weight:800;"><span>Grand total</span><span>\u20B9'+_coBd.grandTotal+'</span></div>';
          bHtml+='<details style="margin-bottom:18px;border:2px solid #000;border-radius:8px;background:#fff;">'
            +'<summary style="display:flex;justify-content:space-between;align-items:center;list-style:none;cursor:pointer;padding:10px 14px;font-size:11px;color:rgba(0,0,0,.6);font-style:italic;">'
            +'<span>Inclusive of all taxes</span><span style="opacity:.7;">\u25BE view breakdown</span>'
            +'</summary>'
            +'<div style="padding:0 14px 12px;font-size:12px;line-height:1.7;color:rgba(0,0,0,.8);font-family:var(--ff);">'+_coRows+'</div>'
            +'</details>';
        } else {
          bHtml+='<div style="margin-bottom:18px;font-size:11px;color:rgba(0,0,0,.5);font-style:italic;text-align:right;padding:0 4px;">Inclusive of all taxes</div>';
        }
        sheet.innerHTML=bHtml;

        // 🆕 2026-05-27 v3.70 (Khushi LIVE-NIGHT) — wallet-funded gate.
        // If the customer's HODTAB cover (or any pre-credited wallet) already
        // has enough balance to settle the whole bill, the Pay Online +
        // Pay at Table buttons make no sense — captain will deduct from the
        // wallet at SETTLE BILL (CaptainMode WalletScanModal). Hide both,
        // show a clear "Captain will be with you shortly to settle the bill"
        // card, and fire the bill_requested signal so captain still gets the
        // alert (red BILL DUE chip + chime) the moment customer taps GET BILL.
        // Bartender / cash flows untouched: only fires when cv.coverBalance >= tt.
        var _walletBal=Number(cv.coverBalance||0);
        if(_walletBal>=tt && tt>0){
          // Fire bill_requested ONCE so captain knows to walk over with QR scanner.
          if(firestore&&cv.ref){
            firestore.collection('tableReservations').where('bookingRef','==',cv.ref).get()
              .then(function(snap){snap.forEach(function(d){d.ref.update({paymentStatus:'bill_requested',orderTotal:tt,tabTotal:tt});});}).catch(function(){});
            firestore.collection('covers').doc(cv.ref).set({paymentStatus:'bill_requested',orderTotal:tt},{merge:true}).catch(function(){});
          }
          // 🆕 2026-05-27 v3.90 (Khushi LIVE-NIGHT) — GROUND-FLOOR TABLE
          // BOOKINGS now get the SAME full settle flow as every other table
          // booking: "CAPTAIN WILL BE WITH YOU SHORTLY" + feedback form +
          // rate-us-on-Google + Thank-You with BACK TO EVENTS. Before, this
          // wallet-funded gate dead-ended in an infoBox + "Back to Menu" so
          // pre-credited HODTAB guests (ground-floor norm) never saw the
          // feedback form. Captain already gets the alert because
          // bill_requested was stamped above (lines 7141-7145) at modal show.
          // We mirror the Pay-at-Table branch (line 7297+) so the UX is
          // identical: stop the wallet listener, drop the checkout sheet,
          // clear the inner shell, render showCaptainFeedback which shows
          // the captain-on-way card + feedback stars + Google-rating flow.
          // FAIL-OPEN: if showCaptainFeedback throws (renderer regression),
          // we fall back to the legacy infoBox + Back-to-Menu so customer
          // is never stranded on a blank screen.
          if(_walletUnsub){_walletUnsub();_walletUnsub=null;}
          overlay.remove();
          try{
            inner.innerHTML='';
            // Re-show the SETTLED banner so customer sees the wallet badge
            // at the top before scrolling into the feedback form.
            var _walletNote=document.createElement('div');
            _walletNote.style.cssText='width:100%;padding:16px 16px;border-radius:8px;background:rgba(34,197,94,.14);border:1.5px solid rgba(34,197,94,.45);color:#000;text-align:center;font-family:var(--ff);margin:18px 0 0;line-height:1.55;';
            _walletNote.innerHTML='<div style="font-size:11px;color:#22C55E;font-weight:900;letter-spacing:1.2px;margin-bottom:6px;">\uD83C\uDFAB WALLET BALANCE \u20B9'+_walletBal.toLocaleString('en-IN')+' \u00B7 BILL \u20B9'+tt+'</div>'
              +'<div style="font-size:12px;color:rgba(0,0,0,.75);font-weight:600;letter-spacing:.3px;">Captain will deduct the bill from your wallet on arrival.</div>';
            inner.appendChild(_walletNote);
            showCaptainFeedback(inner, tt, false);
          }catch(_e){
            // Fallback to legacy infoBox so we never strand the customer.
            var infoBox=document.createElement('div');
            infoBox.style.cssText='width:100%;padding:18px 16px;border-radius:8px;background:rgba(34,197,94,.14);border:1.5px solid rgba(34,197,94,.45);color:#000;font-size:14px;font-weight:700;text-align:center;font-family:var(--ff);margin:18px 0;line-height:1.55;';
            infoBox.innerHTML='<div style="font-size:24px;margin-bottom:6px;">\uD83C\uDFAB</div>'
              +'<div style="font-size:12px;color:#22C55E;font-weight:900;letter-spacing:1.2px;margin-bottom:8px;">WALLET BALANCE \u20B9'+_walletBal.toLocaleString('en-IN')+'</div>'
              +'<div style="font-size:15px;font-weight:900;color:#000;">CAPTAIN WILL BE WITH YOU SHORTLY TO SETTLE THE BILL</div>'
              +'<div style="font-size:11px;color:rgba(0,0,0,.7);font-weight:600;margin-top:8px;letter-spacing:.4px;">Bill amount \u20B9'+tt+' will be deducted from your wallet.</div>';
            inner.appendChild(infoBox);
            var _fbBack=document.createElement('a');
            _fbBack.href='https://hodclub.in';
            _fbBack.style.cssText='display:block;width:100%;padding:12px;border-radius:8px;background:rgba(0,0,0,.06);border:1px solid rgba(255,255,255,.14);color:#000;font-family:var(--ff);font-size:12px;font-weight:900;letter-spacing:.5px;text-transform:uppercase;text-decoration:none;text-align:center;margin-top:10px;';
            _fbBack.textContent='\uD83C\uDFE0 Back to Events';
            inner.appendChild(_fbBack);
          }
          return;
        }

        var poBtn=document.createElement('button');
        poBtn.style.cssText='width:100%;padding:16px;border-radius:8px;background:#FF90E8;border:2px solid #000;color:#000;font-size:15px;font-weight:900;cursor:pointer;font-family:var(--ff);margin-bottom:10px;';
        poBtn.innerHTML='💳  Pay Online  —  ₹'+tt;
        poBtn.onclick=function(){
          if(poBtn.disabled)return;
          poBtn.disabled=true;poBtn.textContent='Opening payment...';
          // ── 2026-05-13 round 9 (Khushi spec): Pay Online → flip captain
          // BILL DUE chip to green ✅ PAID ONLINE.
          // Safety order is critical:
          //   1. Razorpay handler fires ONLY when Razorpay confirms the
          //      charge with a payment_id (success). On dismiss / failure
          //      we NEVER stamp paid — captain keeps seeing BILL DUE.
          //   2. After success we retry the Firestore stamp 3× with
          //      backoff. If all retries fail, we KEEP the bill in
          //      bill_requested state (so the red BILL DUE chip stays
          //      blinking and the captain still walks over) AND show
          //      the customer a non-dismissable Payment-ID screen they
          //      MUST show to the captain. We also drop a best-effort
          //      pendingPaymentNotices/{ref} marker so a later flow can
          //      surface a ⚠️ "customer claims paid" hint if needed.
          //   3. On payment.failed event we re-enable the button.
          function _writePaidOnline(pid){
            if(!firestore||!cv.ref) return Promise.reject(new Error('no_firestore_or_ref'));
            var nowIso=new Date().toISOString();
            var paidPatch={
              paymentStatus:'paid',
              paymentMethod:'paid_online',
              paidAt:nowIso,
              paymentId:pid,
              amountPaid:tt,
              orderTotal:tt,
              tabTotal:tt
            };
            function _attempt(n){
              return firestore.collection('tableReservations').where('bookingRef','==',cv.ref).get()
                .then(function(snap){
                  var ps=[];
                  snap.forEach(function(d){ ps.push(d.ref.update(paidPatch)); });
                  ps.push(firestore.collection('covers').doc(cv.ref).set(paidPatch,{merge:true}));
                  return Promise.all(ps);
                })
                .catch(function(err){
                  if(n<3){
                    return new Promise(function(res){ setTimeout(res, 400*Math.pow(2,n)); })
                      .then(function(){ return _attempt(n+1); });
                  }
                  throw err;
                });
            }
            return _attempt(0);
          }
          function _showPaymentIdFallback(pid){
            // Firestore stamp failed after retries. KEEP captain BILL DUE
            // chip intact (do not flip), surface the Payment ID prominently
            // so customer can show it to the captain in person.
            sheet.innerHTML=
              '<div style="text-align:center;padding:20px 6px;">'
              +'<div style="font-size:48px;margin-bottom:14px;">⚠️</div>'
              +'<div style="font-size:18px;font-weight:900;color:#000;margin-bottom:10px;font-family:var(--ff);">Payment Received — Show This To Your Captain</div>'
              +'<div style="font-size:13px;color:#aaa;margin-bottom:18px;line-height:1.5;font-family:var(--ff);">Razorpay confirmed your payment but we couldn\'t notify your table. Please show this Payment ID to your captain — they will mark your bill paid manually.</div>'
              +'<div style="background:rgba(242,199,68,.12);border:1.5px dashed rgba(242,199,68,.5);border-radius:8px;padding:18px;margin-bottom:18px;">'
              +'<div style="font-size:10px;font-weight:800;color:#000;letter-spacing:1.5px;margin-bottom:8px;">PAYMENT ID</div>'
              +'<div style="font-size:18px;font-weight:900;color:#000;font-family:monospace;letter-spacing:1px;word-break:break-all;">'+sanitize(pid||'(missing)')+'</div>'
              +'<div style="font-size:11px;color:#3D3D3D;margin-top:10px;font-family:var(--ff);">Amount: \u20b9'+tt+' \u00b7 '+new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})+'</div>'
              +'</div>'
              +'<button id="_walletPaidOk" style="width:100%;padding:14px;border-radius:12px;background:#FF90E8;border:2px solid #000;color:#000;font-size:14px;font-weight:900;cursor:pointer;font-family:var(--ff);">Got it \u2014 I\'ll show my captain</button>'
              +'</div>';
            var okBtn=sheet.querySelector('#_walletPaidOk');
            if(okBtn) okBtn.onclick=function(){ overlay.remove(); };
            // Best-effort fallback marker (silent fail)
            try {
              firestore.collection('pendingPaymentNotices').doc(cv.ref).set({
                bookingRef:cv.ref,
                paymentId:pid||'',
                amount:tt,
                claimedAt:new Date().toISOString(),
                source:'wallet_paid_online_writefail'
              }).catch(function(){});
            } catch(_){}
          }
          ensureRazorpay(function(_rzReady){
          if(!_rzReady){ poBtn.disabled=false;poBtn.innerHTML='\ud83d\udcb3  Pay Online  —  \u20b9'+tt; alert('Could not open payment. Check your connection and try again.'); return; }
          try{
          var rz=new Razorpay({
            key:RAZORPAY_KEY,amount:tt*100,currency:'INR',
            name:'HOD — House of Dopamine',
            description:'Table Tab — '+(cv.tableId||cv.ref||''),
            prefill:{name:sanitize(cv.name||''),contact:sanitize(cv.phone||'')},
            theme:{color:'#FF90E8'},
            handler:function(resp){
              var pid=(resp&&resp.razorpay_payment_id)||'';
              if(!pid){
                // Defensive: handler fired without a payment id. Treat as
                // failure — keep BILL DUE intact, do NOT flip to paid.
                alert('\u274c Payment status unclear. Please try again or use Pay at Table.');
                poBtn.disabled=false;poBtn.innerHTML='\ud83d\udcb3  Pay Online  —  \u20b9'+tt;
                return;
              }
              _writePaidOnline(pid).then(function(){
                overlay.remove();
                submitOrder(cv,bal,{mode:'online',paymentId:pid,amount:tt,rounds:tabRounds});
              }).catch(function(err){
                console.error('[HOD wallet] paid_online stamp failed after retries:', err);
                _showPaymentIdFallback(pid);
                // Still record the round so kitchen/bar history is intact,
                // but DELIBERATELY pass mode:'bill_requested' (not 'online')
                // so submitOrder's status branch (~line 6054) lands on
                // 'bill_requested', NOT 'paid'. This guarantees the captain
                // chip stays red BILL DUE — even though the customer holds
                // a valid Razorpay payment id — until the captain manually
                // verifies and marks paid on the door tablet.
                try {
                  submitOrder(cv,bal,{
                    mode:'bill_requested',
                    paymentId:pid,
                    amount:tt,
                    rounds:tabRounds,
                    pendingOnlinePaymentId:pid
                  });
                } catch(_){}
              });
            },
            modal:{ondismiss:function(){poBtn.disabled=false;poBtn.innerHTML='💳  Pay Online  —  ₹'+tt;}}
          });
          if(rz&&typeof rz.on==='function'){
            rz.on('payment.failed',function(r){
              var msg=(r&&r.error&&(r.error.description||r.error.reason))||'Unknown error';
              alert('\u274c Payment failed: '+msg+'\nPlease try again or use Pay at Table.');
              poBtn.disabled=false;poBtn.innerHTML='\ud83d\udcb3  Pay Online  —  \u20b9'+tt;
            });
          }
          rz.open();
          }catch(_e){ poBtn.disabled=false;poBtn.innerHTML='\ud83d\udcb3  Pay Online  —  \u20b9'+tt; alert('Could not open payment. Check your connection and try again.'); }
          });
        };
        sheet.appendChild(poBtn);

        var ptBtn=document.createElement('button');
        ptBtn.style.cssText='width:100%;padding:15px;border-radius:8px;background:rgba(0,0,0,.05);border:1.5px solid rgba(0,0,0,.15);color:#000;font-size:14px;font-weight:700;cursor:pointer;font-family:var(--ff);margin-bottom:10px;';
        ptBtn.innerHTML='🙋  Pay at Table  —  Cash / Card / UPI';
        ptBtn.onclick=function(){
          if(ptBtn.disabled)return;
          ptBtn.disabled=true;ptBtn.textContent='Notifying captain...';
          // Mark bill_requested on reservation so captain gets alerted
          if(firestore&&cv.ref){
            firestore.collection('tableReservations').where('bookingRef','==',cv.ref).get()
              .then(function(snap){snap.forEach(function(d){d.ref.update({paymentStatus:'bill_requested',orderTotal:tt,tabTotal:tt});});}).catch(function(){});
            firestore.collection('covers').doc(cv.ref).set({paymentStatus:'bill_requested',orderTotal:tt},{merge:true}).catch(function(){});
          }
          // Stop the wallet listener BEFORE updating DOM — prevents onSnapshot from re-rendering over the feedback screen
          if(_walletUnsub){_walletUnsub();_walletUnsub=null;}
          overlay.remove();
          // Show captain on way + feedback
          inner.innerHTML='';
          showCaptainFeedback(inner, tt, false);
        };
        sheet.appendChild(ptBtn);

        var bkBtn=document.createElement('button');
        bkBtn.style.cssText='width:100%;padding:12px;background:transparent;border:2px solid #000;color:#3D3D3D;font-size:13px;cursor:pointer;font-family:var(--ff);';
        bkBtn.textContent='← Back to Menu';
        bkBtn.onclick=function(){overlay.remove();};
        sheet.appendChild(bkBtn);

        overlay.appendChild(sheet);document.body.appendChild(overlay);
      }

    function buildMenu2(catObj,itemsDiv){
      // Rebuild just the items in the open category — applies same OOS + discount overrides as buildMenu.
      itemsDiv.innerHTML='';
      var visible = (catObj.items||[]).filter(function(it){ var ov=_ovFor(it.n); return !(ov && ov.outOfStock); });
      visible.forEach(function(item){
        var key=catObj.cat+'|'+item.n;
        var ov=_ovFor(item.n);
        var eff=_effPrice(item.n, item.p);
        var hasDisc = eff !== item.p;
        var row=document.createElement('div');
        row.className='wv-row';
        row.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:10px;';
        var isVeg=item.v===true;
        var vegDot=typeof item.v!=='undefined'?'<span class="wv-vegdot" style="color:'+(isVeg?'#00C864':'#FF5733')+';"></span>':'';
        var priceHtml = hasDisc
          ? '<span style="text-decoration:line-through;color:rgba(0,0,0,.4);margin-right:6px;font-weight:600;font-family:var(--ff);">\u20b9'+item.p+'</span>'
            +'<span style="color:#000;font-weight:900;font-family:var(--ff);">\u20b9'+eff+'</span>'
            +(ov && ov.discountReason ? '<span style="color:rgba(242,199,68,.75);font-size:10px;margin-left:6px;font-weight:600;">\u00b7 '+sanitize(ov.discountReason)+'</span>' : '')
          : '<span style="color:#000;font-weight:900;font-family:var(--ff);">\u20b9'+item.p+'</span>';
        row.innerHTML='<div style="flex:1;min-width:0;"><div style="display:flex;align-items:center;font-size:14px;font-weight:700;color:#000;letter-spacing:.2px;">'+vegDot+'<span style="text-transform:uppercase;letter-spacing:.4px;">'+sanitize(item.n)+'</span></div>'
          +'<div style="font-size:14px;font-family:var(--ff);font-weight:800;margin-top:4px;letter-spacing:.3px;">'+priceHtml+'</div></div>';
        var ctrl=document.createElement('div');ctrl.style.cssText='display:flex;align-items:center;gap:10px;flex-shrink:0;';
        var qty=cart[key]?cart[key].qty:0;
        if(qty===0){
          var addBtn=document.createElement('button');
          addBtn.className='wv-add';
          addBtn.textContent='Add +';
          addBtn.onclick=(function(k,it,cat2){return function(){
            cart[k]={n:it.n,p:_effPrice(it.n,it.p),cat:cat2,qty:1,t:it.t||'drink',alc:it.alc===false?false:(it.t==='food'?false:true)};updateCartBar();updateTabFooter();buildMenu2(catObj,itemsDiv);
          };})(key,item,catObj.cat);
          ctrl.appendChild(addBtn);
        } else {
          var minB=document.createElement('button');minB.className='wv-qbtn';
          minB.textContent='\u2212';
          minB.onclick=(function(k){return function(){
            if(cart[k].qty>1)cart[k].qty--;else delete cart[k];
            updateCartBar();updateTabFooter();buildMenu2(catObj,itemsDiv);
          };})(key);
          var qtySpan=document.createElement('span');qtySpan.className='wv-qty';qtySpan.textContent=qty;
          var plusB=document.createElement('button');plusB.className='wv-qbtn';plusB.textContent='+';
          plusB.onclick=(function(k,it,cat2){return function(){
            if(!cart[k])cart[k]={n:it.n,p:_effPrice(it.n,it.p),cat:cat2,qty:0,t:it.t||'drink',alc:it.alc===false?false:(it.t==='food'?false:true)};
            cart[k].qty++;updateCartBar();updateTabFooter();buildMenu2(catObj,itemsDiv);
          };})(key,item,catObj.cat);
          ctrl.appendChild(minB);ctrl.appendChild(qtySpan);ctrl.appendChild(plusB);
        }
        row.appendChild(ctrl);itemsDiv.appendChild(row);
      });
    }

    buildMenu(currentMenuData());

    // 🔴 2026-05-25 (Khushi GO-LIVE BUG FIX) — expose a re-render hook on
    // window so the posMenuOverrides onSnapshot listener (line ~1137) can
    // force the open wallet menu to repaint the instant Admin toggles OOS
    // or a discount. Without this hook, POS_MENU_OVERRIDES was being
    // updated in memory but the DOM stayed stale → customers had to pull-
    // to-refresh to see the change. menuContent + buildMenu + currentMenuData
    // are closure-captured here so we can rebuild from outside.
    // FALLBACK: if menuContent has been detached (wallet closed), the
    // listener still safely no-ops because we only render when it's mounted.
    window.__rebuildWalletMenu = function(){
      try{
        if(!menuContent || !menuContent.isConnected) return;
        menuContent.innerHTML='';
        buildMenu(currentMenuData());
      }catch(e){ console.warn('__rebuildWalletMenu failed', e); }
    };

    // 2026-05-13 (Khushi spec) — bottom-fixed "View Cart · N items · ₹X" red
    // footer removed. It duplicated the YOUR ORDER list + Place Order CTA
    // shown immediately above the menu and felt heavy on small screens.
    // Stub kept so any leftover updateCartBar callsites stay wired up — it
    // now no-ops, the cart total + line items are visible in the inline
    // YOUR ORDER block that already lives in `submitCard`.
    function updateCartFooter(){ /* footer removed */ }
    var _origUpdateCartBar=updateCartBar;
    updateCartBar=function(){_origUpdateCartBar();updateCartFooter();};
    updateCartFooter();

    // Populate red header ref (#REF) once cv is known
    var refEl=document.getElementById('wv-hd2-ref');
    if(refEl){
      var refTxt=cv.ref||cv.bookingId||cv.id||'';
      refEl.innerHTML=refTxt?('#'+sanitize(refTxt)):'&nbsp;';
    }

    // 2026-05-13 (Khushi spec) — wire the "Call Waiter" header button to
    // Firestore `waiterCalls`. The POS already listens (WaiterCallBanner in
    // CaptainMode + BarMode subscribeActiveWaiterCalls) — beeps + red
    // banner with ACK button. Throttle to 1 call / 30 s per wallet so a
    // toddler can't spam the floor. On success we morph the button to a
    // green "✓ Captain notified" pill that auto-resets after 30 s.
    var callBtn=document.getElementById('wv-hd2-call-btn');
    var callLbl=document.getElementById('wv-hd2-call-label');
    // 🆕 2026-06-02 v3.183 (Khushi) — CALL WAITER only makes sense when a
    // table is attached. Pure cover / dance-floor wallets have no waiter, so
    // hide the button entirely for them.
    var _hasTableForCall=!!(cv.isTableBooking||cv.linkedTableRef||cv.tableId);
    if(callBtn && !_hasTableForCall){callBtn.style.display='none';}
    if(callBtn&&callLbl&&_hasTableForCall){
      callBtn.disabled=false;
      callBtn.style.opacity='1';
      callBtn.style.cursor='pointer';
      var _wcCooldownUntil=0;
      callBtn.onclick=function(){
        var nowMs=Date.now();
        if(nowMs<_wcCooldownUntil){return;}
        // 🆕 2026-05-27 v3.43 (Khushi) — ARRIVAL GATE.
        // Customers were tapping Call Waiter from HOME before arriving,
        // making captain tablets beep for no-shows. Block the call unless
        // (a) table booking has actualArrivalTime set (captain/door marked
        //     "Guest Arrived"), OR
        // (b) cover booking has coverActivated > 0 (door scanned them in).
        // Honest toast tells them why. Cooldown NOT consumed on this path
        // so they can try again the instant they arrive.
        var _hasArrived = !!(cv.actualArrivalTime) || ((cv.coverActivated||0) > 0);
        if(!_hasArrived){
          if(typeof showToast==='function') showToast('PLEASE CHECK IN AT THE DOOR FIRST — CAPTAIN ONLY AVAILABLE ONCE YOU ARRIVE','err',4500);
          return;
        }
        // 2026-05-13 (Khushi spec v3) — NEVER fall back to tel: dialler.
        // The number 9686444906 is the venue's main reception, not a
        // captain's phone — dialling it during service is worse than
        // doing nothing. If firestore isn't ready, show an error toast
        // and ask the guest to wave down a captain instead.
        var fb=window.firestore || (window.firebase && window.firebase.firestore && window.firebase.firestore());
        if(!fb){
          if(typeof showToast==='function') showToast('Connection issue — please wave down a captain.','err',4000);
          return;
        }
        _wcCooldownUntil=nowMs+30000;
        callBtn.disabled=true;
        callBtn.style.opacity='.7';
        callBtn.style.cursor='wait';
        callLbl.textContent='Calling…';
        function _resetBtn(){
          callBtn.style.background='transparent';
          callBtn.style.padding='0';
          callBtn.style.opacity='1';
          callBtn.style.cursor='pointer';
          callBtn.disabled=false;
          callLbl.textContent='Call Waiter';
        }
        // 🔴 2026-05-20 (Khushi bug fix) — root cause of "couldn't notify":
        // production Firestore rules reject unauth writes to `waiterCalls`,
        // so the old code (which depended on that write succeeding) always
        // showed the red error. Fix: race BOTH surfaces in parallel and
        // succeed if EITHER lands.
        //   1. customerCallRequest on tableReservations (linked tables) —
        //      proven path: same write the "I'M AT MY TABLE" flow uses,
        //      already allowed by prod rules.
        //   2. waiterCalls.add (every cover) — works once Khushi deploys
        //      the unauth rule on Mac; harmless fallback until then.
        // For a pure bar walk-in (no linkedTableRef) only path #2 is
        // available — if rules block it we surface an honest "wave to
        // bartender" message instead of misleading "wave one down".
        try{
          var hasLinkedTable = !!(cv && cv.linkedTableRef);
          var p1 = hasLinkedTable
            ? fb.collection('tableReservations').doc(cv.linkedTableRef).update({
                customerCallRequest: {
                  at: new Date().toISOString(),
                  itemsPreview: 'Call Waiter',
                  total: 0,
                  source: 'header_call_button'
                }
              })
            : Promise.reject(new Error('no_linked_table'));
          var p2 = fb.collection('waiterCalls').add({
            coverRef:cv.ref||cv.bookingId||cv.id||'',
            customerName:cv.name||'Guest',
            tableId:cv.tableId||cv.linkedTableId||null,
            floorLabel:cv.floorLabel||cv.linkedFloorLabel||null,
            status:'pending',
            createdAt:firebase.firestore.FieldValue.serverTimestamp(),
            acknowledgedAt:null,
            acknowledgedBy:null
          });
          Promise.allSettled([p1, p2]).then(function(results){
            var anyOk = results.some(function(r){ return r.status === 'fulfilled'; });
            results.forEach(function(r, i){
              if (r.status === 'rejected') console.warn('[waiterCall] surface '+(i+1)+' failed', r.reason);
            });
            if (anyOk) {
              callBtn.style.background='rgba(0,200,100,.18)';
              callBtn.style.borderRadius='8px';
              callBtn.style.padding='4px 8px';
              callLbl.textContent='✓ Captain notified';
              setTimeout(_resetBtn,30000);
            } else {
              _resetBtn();
              _wcCooldownUntil=0;
              // 🛟 Honest fallback message — for bar walk-ins the bartender
              // IS right there; for table guests the captain will come round.
              var msg = hasLinkedTable
                ? 'Could not reach captain — please wave them down.'
                : 'Please show your QR to the bartender — they will help you.';
              if(typeof showToast==='function') showToast(msg,'err',4500);
            }
          });
        }catch(e){
          console.warn('[waiterCall] threw',e);
          _resetBtn();
          _wcCooldownUntil=0;
          if(typeof showToast==='function') showToast('Could not notify captain — please wave one down.','err',4000);
        }
      };
    }
  }

  // 2026-05-13 (Khushi spec v3) — Wire the Call Waiter header button even
  // for screens that don't go through renderWalletContent (e.g. the
  // post-release "Table session ended" empty state). Mirrors the wiring
  // above but reads cv-like fallbacks from URL since cv may not exist.
  function wireCallWaiterFallback(refStr){
    var callBtn=document.getElementById('wv-hd2-call-btn');
    var callLbl=document.getElementById('wv-hd2-call-label');
    if(!callBtn||!callLbl) return;
    callBtn.disabled=false;
    callBtn.style.opacity='1';
    callBtn.style.cursor='pointer';
    var _cd=0;
    callBtn.onclick=function(){
      var nowMs=Date.now();
      if(nowMs<_cd) return;
      var fb=window.firestore || (window.firebase && window.firebase.firestore && window.firebase.firestore());
      if(!fb){
        if(typeof showToast==='function') showToast('Connection issue — please wave down a captain.','err',4000);
        return;
      }
      _cd=nowMs+30000;
      callBtn.disabled=true; callLbl.textContent='Calling…';
      try{
        fb.collection('waiterCalls').add({
          coverRef:refStr||'',
          customerName:'Guest',
          tableId:null,
          floorLabel:null,
          status:'pending',
          createdAt:firebase.firestore.FieldValue.serverTimestamp(),
          acknowledgedAt:null,
          acknowledgedBy:null
        }).then(function(){
          callBtn.style.background='rgba(0,200,100,.18)';
          callLbl.textContent='✓ Captain notified';
          setTimeout(function(){
            callBtn.style.background='transparent';
            callBtn.disabled=false;
            callLbl.textContent='Call Waiter';
          },30000);
        }).catch(function(){
          callBtn.disabled=false; callLbl.textContent='Call Waiter'; _cd=0;
          if(typeof showToast==='function') showToast('Could not notify captain — please wave one down.','err',4000);
        });
      }catch(e){
        callBtn.disabled=false; callLbl.textContent='Call Waiter'; _cd=0;
        if(typeof showToast==='function') showToast('Could not notify captain — please wave one down.','err',4000);
      }
    };
  }

  function showCheckout(cv,bal,tabRounds,tabRunningTotal){
    var existingOvr=document.getElementById('checkout-overlay');
    if(existingOvr)existingOvr.remove();
    var ovr=document.createElement('div');
    ovr.id='checkout-overlay';
    ovr.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;overflow-y:auto;display:flex;align-items:flex-end;justify-content:center;';
    var sheet=document.createElement('div');
    sheet.style.cssText='background:#F4F4F0;border:2px solid #000;border-bottom:none;border-radius:24px 24px 0 0;padding:28px 24px 40px;width:100%;max-width:480px;box-shadow:0 -20px 60px rgba(0,0,0,.4);';
    sheet.innerHTML='<div style="text-align:center;margin-bottom:20px;"><div style="font-size:28px;margin-bottom:8px;">🧾</div>'
      +'<div style="font-family:var(--ff);font-size:22px;font-weight:900;color:#000;">Your Bill</div>'
      +'<div style="font-size:12px;color:#3D3D3D;margin-top:4px;">'+sanitize(cv.name||'')+(cv.tableId?' · '+sanitize(cv.tableId):'')+' </div></div>';
    var billDiv=document.createElement('div');
    billDiv.style.cssText='background:rgba(0,0,0,.03);border:2px solid #000;border-radius:8px;padding:16px;margin-bottom:20px;';
    tabRounds.forEach(function(rd,i){
      var rh=document.createElement('div');
      rh.style.cssText='font-size:10px;font-weight:800;color:#3D3D3D;letter-spacing:1.5px;text-transform:uppercase;padding:6px 0 4px;'+(i>0?'border-top:1px solid rgba(0,0,0,.06);margin-top:6px;':'');
      rh.textContent='Round '+(i+1);billDiv.appendChild(rh);
      rd.items.forEach(function(it){
        var row=document.createElement('div');
        row.style.cssText='display:flex;justify-content:space-between;padding:4px 0;font-size:13px;';
        row.innerHTML='<span>'+it.qty+'x '+sanitize(it.n)+'</span><span style="color:#000;font-weight:700;">Rs '+(it.p*it.qty)+'</span>';
        billDiv.appendChild(row);
      });
      var rs=document.createElement('div');
      rs.style.cssText='display:flex;justify-content:space-between;padding:5px 0;font-size:11px;color:#3D3D3D;';
      rs.innerHTML='<span>Subtotal</span><span>Rs '+rd.total+'</span>';
      billDiv.appendChild(rs);
    });
    var gtDiv=document.createElement('div');
    gtDiv.style.cssText='display:flex;justify-content:space-between;border-top:1.5px solid rgba(242,199,68,.3);margin-top:10px;padding-top:12px;font-size:18px;font-weight:900;';
    gtDiv.innerHTML='<span>Total</span><span style="color:#000;">Rs '+tabRunningTotal+'</span>';
    billDiv.appendChild(gtDiv);sheet.appendChild(billDiv);
    var payBtn=document.createElement('button');
    payBtn.style.cssText='width:100%;padding:16px;border-radius:8px;background:#FF90E8;border:2px solid #000;color:#000;font-size:15px;font-weight:900;cursor:pointer;font-family:var(--ff);margin-bottom:10px;';
    payBtn.textContent='Pay Online — Rs '+tabRunningTotal;
    payBtn.onclick=function(){
      if(payBtn.disabled)return;
      payBtn.disabled=true;payBtn.textContent='Opening payment...';
      ensureRazorpay(function(_rzReady){
      if(!_rzReady){ payBtn.disabled=false;payBtn.textContent='Pay Online — Rs '+tabRunningTotal; alert('Could not open payment. Check your connection and try again.'); return; }
      try{
      var _rz=new Razorpay({
        key:RAZORPAY_KEY,amount:tabRunningTotal*100,currency:'INR',
        name:'HOD — House of Dopamine',description:'Bill — '+(cv.tableId||cv.ref||''),
        prefill:{name:sanitize(cv.name||''),contact:sanitize(cv.phone||'')},
        theme:{color:'#FF90E8'},
        handler:function(resp){ovr.remove();submitOrder(cv,bal,{mode:'online',paymentId:resp.razorpay_payment_id,amount:tabRunningTotal,rounds:tabRounds});},
        modal:{ondismiss:function(){payBtn.disabled=false;payBtn.textContent='Pay Online — Rs '+tabRunningTotal;}}
      });
      _rz.open();
      }catch(_e){ payBtn.disabled=false;payBtn.textContent='Pay Online — Rs '+tabRunningTotal; alert('Could not open payment. Check your connection and try again.'); }
      });
    };
    sheet.appendChild(payBtn);
    var cashBtn=document.createElement('button');
    cashBtn.style.cssText='width:100%;padding:15px;border-radius:8px;background:rgba(0,0,0,.05);border:1.5px solid rgba(0,0,0,.15);color:#000;font-size:14px;font-weight:700;cursor:pointer;font-family:var(--ff);margin-bottom:10px;';
    cashBtn.textContent='Pay with Waiter — Cash or Card';
    cashBtn.onclick=function(){cashBtn.disabled=true;cashBtn.textContent='Notifying waiter...';ovr.remove();submitOrder(cv,bal,{mode:'cash',amount:tabRunningTotal,rounds:tabRounds});};
    sheet.appendChild(cashBtn);
    var closeBtn=document.createElement('button');
    closeBtn.style.cssText='width:100%;padding:12px;border-radius:12px;background:transparent;border:2px solid #000;color:#3D3D3D;font-size:13px;cursor:pointer;font-family:var(--ff);';
    closeBtn.textContent='Back — Keep ordering';
    closeBtn.onclick=function(){ovr.remove();};
    sheet.appendChild(closeBtn);
    ovr.appendChild(sheet);document.body.appendChild(ovr);
  }


  function submitOrder(cv,bal,payInfo){
    var items=Object.values(cart);
    // For tab checkout (rounds already placed), cart may be empty
    var _isTabCheckout=payInfo&&payInfo.rounds&&payInfo.rounds.length>0;
    if(!items.length&&!_isTabCheckout){showToast('Please select at least one item.','err',3000);return;}
    // 2026-05-13 round 9 fix: when this is a tab checkout (cart already
    // emptied into rounds), getCartTotal() returns 0. Fall back to the
    // running tab amount passed in via _pay.amount, otherwise the
    // "Payment Done!" screen shows "✅ ₹0 paid online" — confusing the
    // customer even though the captain side correctly shows the real
    // amount stamped via _writePaidOnline.
    var _cartTotal=getCartTotal();
    var coverDocId=(cv.bookingId||cv.ref||'').replace(/[^a-zA-Z0-9_-]/g,'_');
    if(!firestore){showToast('Not connected. Try again.','err',3000);return;}
    var _pay=payInfo||{mode:'cash',amount:_cartTotal};
    var total = (_cartTotal>0) ? _cartTotal : (typeof _pay.amount==='number'?_pay.amount:0);
    var orderData={
      items:items.map(function(it){return {n:it.n,p:it.p,qty:it.qty,cat:it.cat,t:it.t||"drink",alc:it.alc===false?false:(it.t==="food"?false:true)};}),
      total:total,
      submittedAt:new Date().toISOString(),
      status:(_pay.mode==='online'&&_pay.paymentId)?'paid':(_pay.mode==='online'?'payment_pending':'bill_requested'),
      paymentMode:_pay.mode,
      paymentId:_pay.paymentId||'',
      amountPaid:(_pay.mode==='online'&&_pay.paymentId)?(_pay.amount||total):0,
      orderRounds:_pay.rounds||orderData.items.map(function(it){return {round:1,items:[it],total:it.p*it.qty,status:'pending'};}),
      customerName:cv.name,
      phone:cv.phone,
      balanceAtOrder:bal
    };
    var _updatePromises=[firestore.collection('covers').doc(coverDocId).set({pendingOrder:orderData,ref:cv.ref||cv.bookingId||'',name:cv.name||'',phone:cv.phone||''},{merge:true})];
    // If table booking, also update tableReservations with payment info
    if(cv.isTableBooking&&cv.ref){
      _updatePromises.push(
        firestore.collection('tableReservations').where('bookingRef','==',cv.ref).get()
          .then(function(snap){
            snap.forEach(function(d){
              d.ref.update({
                orderTotal:orderData.total,
                paymentMode:orderData.paymentMode,
                paymentStatus:orderData.status,
                paymentId:orderData.paymentId||'',
                amountPaid:orderData.amountPaid,
                orderedAt:orderData.submittedAt,
                orderItems:orderData.items
              });
            });
          }).catch(function(){})
      );
    }
    Promise.all(_updatePromises)
      .then(function(){
        inner.innerHTML='';
        var conf=document.createElement('div');conf.style.cssText='padding:40px 20px;text-align:center;';
        var _isOnline=_pay&&_pay.mode==='online';
        conf.innerHTML='<div style="font-size:48px;margin-bottom:12px;">'+(_isOnline?'💳':'🙋')+'</div>'
          +'<div style="font-family:var(--ff);font-size:24px;font-weight:900;color:#000;margin-bottom:8px;">'+(_isOnline?'Payment Done!':'Order Placed!')+'</div>'
          +'<div style="background:rgba(242,199,68,.08);border:2px solid #000;border-radius:12px;padding:12px 16px;margin-bottom:14px;font-size:13px;">'
          +(_isOnline?'✅ ₹'+orderData.total+' paid online · ID: '+(_pay.paymentId||'').slice(-8):'💵 Pay ₹'+orderData.total+' to your waiter on arrival')+'</div>'
          +'<div style="font-size:12px;color:#3D3D3D;margin-bottom:12px;">Show QR below to your waiter</div>'
          +'<div id="conf-qr-wrap" style="width:120px;height:120px;background:#fff;border-radius:12px;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;"></div>'
          +'<div style="background:#fff;border:2px solid #000;border-radius:8px;padding:16px;margin-bottom:20px;text-align:left;">';
        items.forEach(function(it){
          conf.innerHTML+='<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(0,0,0,.05);font-size:13px;">'
            +'<span>'+it.qty+'x '+sanitize(it.n)+'</span>'
            +'<span style="color:#000;">₹'+(it.p*it.qty)+'</span></div>';
        });
        conf.innerHTML+='<div style="display:flex;justify-content:space-between;padding:10px 0 0;font-size:14px;font-weight:900;">'
          +'<span>Total</span><span style="color:#000;">₹'+total.toLocaleString('en-IN')+'</span></div></div>'
          +'<div style="font-size:12px;color:#3D3D3D;">Wallet Balance: ₹'+bal.toLocaleString('en-IN')+'</div>';
        // 🔴 2026-05-13 (Khushi) — "View Bill" button after payment.
        // Customer can tap to see the full itemized GST invoice (matches
        // the captain's thermal print). For online-paid: pull items from
        // _pay.rounds (tab checkout) or fall back to the local cart.
        if(_isOnline){
          var _billItems = (_pay && _pay.rounds && _pay.rounds.length)
            ? _hodFlattenRounds(_pay.rounds)
            : items.slice();
          var vb=document.createElement('button');
          vb.style.cssText='display:block;margin:14px auto 0;padding:11px 20px;border-radius:8px;background:rgba(242,199,68,.15);border:2px solid #000;color:#000;font-size:13px;font-weight:800;cursor:pointer;font-family:var(--ff);letter-spacing:.6px;text-transform:uppercase;';
          vb.textContent='📄 View Bill';
          vb.onclick=function(){
            showHodBillModal(_billItems, {
              customerName: cv.name||'',
              tableId: cv.tableId||'',
              paymentMode: 'paid_online',
              paymentId: _pay.paymentId||'',
              amountPaid: _pay.amount||total,
              settledAt: orderData.submittedAt
            });
          };
          conf.appendChild(vb);
        }
        inner.appendChild(conf);
        generateLocalQR('conf-qr-wrap', 'https://hodclub.in/?verify='+encodeURIComponent(cv.ref||cv.bookingId||cv.id||'')+'');
      setTimeout(function(){generateLocalQR('conf-qr-wrap','https://hodclub.in/?verify='+encodeURIComponent(cv.ref||cv.bookingId||cv.id||'')+'');
        // Add feedback form below QR
        showCaptainFeedback(inner, total, true);},400);
      }).catch(function(e){
      var sb2=document.getElementById('wallet-submit-btn');
      if(sb2){sb2.disabled=false;sb2.textContent='Submit Pre-Order';}
      showToast('Failed to submit: '+e.message,'err',4000);
    });
  }

  // Load cover from Firebase — real-time listener so captain edits reflect immediately on customer screen
  if(firestore&&bookingRef){
    var _walletUnsub=null;
    // Session-scoped flag — true only after we've seen at least one
    // non-empty snapshot for this ref in this page session. Combined with
    // the localStorage breadcrumb, this prevents the "Thank you" screen
    // from flashing on initial cache-empty / transient-empty snapshots
    // for a returning customer whose breadcrumb is from a prior visit.
    var _seenLiveDocThisSession=false;
    function _startTableListener(){
      if(_walletUnsub){_walletUnsub();_walletUnsub=null;}
      _walletUnsub=firestore.collection('tableReservations').where('bookingRef','==',bookingRef).limit(1)
        .onSnapshot(function(tSnap){
          inner.innerHTML='';
          if(tSnap.empty){
            // Three scenarios land here: (a) brand-new pre-arrival booking
            // for which the captain hasn't created a tableReservations doc
            // yet, (b) the captain has RELEASED the table mid-session
            // (doc deleted/archived), or (c) the customer is opening the
            // wallet for the FIRST time after release (no breadcrumb, no
            // session flag). To distinguish (a) from (b)/(c), we now also
            // do a one-shot get on `releasedReservations/{bookingRef}`,
            // a marker doc the POS writes inside `releaseTable`. If that
            // doc exists → committed release, render thank-you immediately
            // regardless of breadcrumb/session state. Decision rules
            // (Khushi spec v4, 2026-05-13):
            //   • Marker doc exists → release (commit immediately).
            //   • Else if seen non-empty doc THIS session → release.
            //   • Else if breadcrumb exists → likely release, show 1.5s
            //     "Connecting…" spinner first to absorb transient empties.
            //   • Else → genuine pre-arrival.
            var visitKey='hod_wallet_visited_'+bookingRef;
            var hasVisited=false;
            try{ hasVisited=!!localStorage.getItem(visitKey); }catch(e){}
            var commitToThankYou=_seenLiveDocThisSession;
            // One-shot marker check — only meaningful for TBL-/AGG- refs
            // (covers/guestlist refs handled by other listeners). Fires
            // synchronously alongside the existing breadcrumb logic so we
            // don't add latency to the pre-arrival path.
            // 🆕 v3.62 — debounce the releasedReservations get() by 300ms.
            // Firestore returns transient empty snapshots while a write is
            // applying; without the debounce a busy table fires get() 2-3
            // times in quick succession per wallet load. The marker doc
            // (if it exists) is by definition stable — 300ms latency is
            // imperceptible vs. the pre-arrival paint that's already on
            // screen. Cancel pending check on any future non-empty snap.
            if(!commitToThankYou && (bookingRef.indexOf('TBL-')===0||bookingRef.indexOf('AGG-')===0)){
              try{
                if(window.__hodRelChkTimer){clearTimeout(window.__hodRelChkTimer);}
                window.__hodRelChkTimer=setTimeout(function(){
                  window.__hodRelChkTimer=null;
                  if(_seenLiveDocThisSession) return; // live doc arrived during the wait
                  firestore.collection('releasedReservations').doc(bookingRef).get().then(function(mDoc){
                  if(!mDoc.exists) return;
                  // Marker found — render thank-you screen immediately,
                  // overriding any pre-arrival paint that may already be
                  // on screen. Drop a breadcrumb so subsequent refreshes
                  // skip straight to thank-you on the breadcrumb path too.
                  try{ localStorage.setItem(visitKey,'1'); }catch(e){}
                  _seenLiveDocThisSession=true;
                  inner.innerHTML='<div style="text-align:center;padding:60px 20px;">'
                    +'<div style="font-size:54px;margin-bottom:14px;">🙏</div>'
                    +'<div style="font-family:var(--ff);font-size:22px;font-weight:800;color:#000;margin-bottom:10px;">Thank you for visiting!</div>'
                    +'<div style="font-size:14px;color:#3D3D3D;line-height:1.7;max-width:300px;margin:0 auto 14px;">Your table session has ended. We hope you had a wonderful evening at House of Dopamine.</div>'
                    +'<div style="font-family:monospace;font-size:13px;color:rgba(242,199,68,.55);margin-top:6px;letter-spacing:2px;">'+sanitize(bookingRef)+'</div>'
                    +'<div style="margin-top:24px;font-size:12px;color:#888;">See you again soon ✨</div>'
                  +'</div>';
                  try{ if(typeof renderHodFeedbackForm==='function') renderHodFeedbackForm(inner, 0); }catch(e){}
                  try{ wireCallWaiterFallback(bookingRef); }catch(e){}
                  }).catch(function(){});
                }, 300);
              }catch(e){}
            }
            if(!commitToThankYou && hasVisited){
              // Show a brief connecting state, then commit. If a non-empty
              // snapshot arrives in the meantime, this branch never runs
              // because onSnapshot will fire again with the live doc.
              inner.innerHTML='<div style="text-align:center;padding:80px 20px;color:#3D3D3D;">'
                +'<div style="font-size:13px;letter-spacing:1.2px;text-transform:uppercase;opacity:.7;">Connecting…</div>'
              +'</div>';
              setTimeout(function(){
                // Re-check: if a live snapshot arrived during the wait
                // and flipped the session flag / repainted, do nothing.
                if(_seenLiveDocThisSession) return;
                // Still empty — render thank-you state.
                inner.innerHTML='<div style="text-align:center;padding:60px 20px;">'
                  +'<div style="font-size:54px;margin-bottom:14px;">🙏</div>'
                  +'<div style="font-family:var(--ff);font-size:22px;font-weight:800;color:#000;margin-bottom:10px;">Thank you for visiting!</div>'
                  +'<div style="font-size:14px;color:#3D3D3D;line-height:1.7;max-width:300px;margin:0 auto 14px;">Your table session has ended. We hope you had a wonderful evening at House of Dopamine.</div>'
                  +'<div style="font-family:monospace;font-size:13px;color:rgba(242,199,68,.55);margin-top:6px;letter-spacing:2px;">'+sanitize(bookingRef)+'</div>'
                  +'<div style="margin-top:24px;font-size:12px;color:#888;">See you again soon ✨</div>'
                +'</div>';
                try{ if(typeof renderHodFeedbackForm==='function') renderHodFeedbackForm(inner, 0); }catch(e){}
                try{ wireCallWaiterFallback(bookingRef); }catch(e){}
              },1500);
              try{ wireCallWaiterFallback(bookingRef); }catch(e){}
              return;
            }
            if(commitToThankYou){
              // Post-release / session-ended state — Khushi spec 2026-05-13.
              inner.innerHTML='<div style="text-align:center;padding:60px 20px;">'
                +'<div style="font-size:54px;margin-bottom:14px;">🙏</div>'
                +'<div style="font-family:var(--ff);font-size:22px;font-weight:800;color:#000;margin-bottom:10px;">Thank you for visiting!</div>'
                +'<div style="font-size:14px;color:#3D3D3D;line-height:1.7;max-width:300px;margin:0 auto 14px;">Your table session has ended. We hope you had a wonderful evening at House of Dopamine.</div>'
                +'<div style="font-family:monospace;font-size:13px;color:rgba(242,199,68,.55);margin-top:6px;letter-spacing:2px;">'+sanitize(bookingRef)+'</div>'
                +'<div style="margin-top:24px;font-size:12px;color:#888;">See you again soon ✨</div>'
              +'</div>';
              // Drop a feedback prompt under the thank-you so we still
              // capture how the evening went.
              try{ if(typeof renderHodFeedbackForm==='function') renderHodFeedbackForm(inner, 0); }catch(e){}
            } else {
              inner.innerHTML='<div style="text-align:center;padding:60px 20px;">'
                +'<div style="font-size:48px;margin-bottom:12px;">🪑</div>'
                +'<div style="font-size:16px;font-weight:800;color:#000;margin-bottom:8px;">Table Reservation</div>'
                +'<div style="font-size:13px;color:#3D3D3D;line-height:1.7;">Your table will be set up when you arrive at HOD.<br>Show your booking reference at the entrance.</div>'
                +'<div style="font-family:monospace;font-size:16px;color:#000;margin-top:12px;letter-spacing:2px;">'+sanitize(bookingRef)+'</div>'
              +'</div>';
            }
            try{ wireCallWaiterFallback(bookingRef); }catch(e){}
            return;
          }
          // Customer has a live tableReservations doc — flip the
          // session flag and drop a breadcrumb so a future doc-delete
          // (captain release) shows the "Thank you for visiting" screen
          // instead of the pre-arrival one.
          _seenLiveDocThisSession=true;
          try{ localStorage.setItem('hod_wallet_visited_'+bookingRef,'1'); }catch(e){}
          var td=tSnap.docs[0].data();
          renderWalletContent({
            ref:bookingRef,name:td.customerName||'',phone:td.phone||'',
            coverBalance:td.coverBalance||0,coverActivated:td.coverActivated||0,
            coverUsed:td.coverUsed||0,transactions:[],
            eventTitle:(td.tableId||'')+' · '+(td.floorLabel||''),
            tableId:td.tableId,floor:td.floor,floorLabel:td.floorLabel||'',
            date:td.date,arrivalTime:td.arrivalTime,partySize:td.partySize,
            actualArrivalTime:td.actualArrivalTime||null,
            isTableBooking:true,tabRounds:td.tabRounds||[],tabTotal:td.tabTotal||0,expiresAt:null,
            // 🆕 2026-06-07 — bartender's bill-level discount/SC mirrored onto the
            // tableReservations doc (by setCoverBillDiscount) so the table guest's
            // VIEW BILL + YOUR TAB grand match the bar.
            billDiscountPct:td.billDiscountPct||0,billScOn:(td.billScOn!==false),
            // Pass source/aggregator flags so song-request hide logic works
            source:td.source||'',
            isAggregator:!!(td.source&&td.source!=='inhouse')||bookingRef.startsWith('AGG-'),
            // 🔴 2026-05-13 (Khushi) — payment fields piped through so the
            // "✅ Bill Settled · View Bill" banner can render the moment
            // the captain marks paid (offline) or a wallet pay-online
            // stamp lands. Without this, the customer wouldn't see any
            // confirmation until the table is released.
            paymentStatus:td.paymentStatus||'',
            paymentMethod:td.paymentMethod||td.paymentMode||'',
            paymentId:td.paymentId||'',
            amountPaid:td.amountPaid||0,
            paidAt:td.paidAt||td.orderedAt||null
          });
        },function(){inner.innerHTML='<div style="text-align:center;padding:60px;color:#3D3D3D;">Error loading wallet.</div>';});
    }
    function _startCoversListener(field){
      if(_walletUnsub){_walletUnsub();_walletUnsub=null;}
      _walletUnsub=firestore.collection('covers').where(field,'==',bookingRef).limit(1)
        .onSnapshot(function(snap){
          inner.innerHTML='';
          if(snap.empty){
            if(field==='ref'){_startCoversListener('bookingId');return;}
            // 🆕 2026-06-02 (Khushi) — AGGREGATOR table bookings (refs like
            // ZOMATO-MAN-xxxx / SWIGGY-MAN-xxxx / MAGICPIN-MAN-xxxx) had no
            // cover minted reliably, so the wallet stayed LOCKED even after the
            // door girl marked the guest arrived. They ARE table reservations,
            // so route them to the table listener (which unlocks the moment
            // actualArrivalTime is stamped) — independent of cover-mint success.
            // 🆕 2026-06-02 v3.182 (Khushi) — aggregator refs were shortened from
            // "SWIGGY-MAN-xxxx" to the HOD<AGG3><digits> form ("HODSWI234156",
            // HODZOM…/HODEAZ…/HODMAG…/HODDIN…). Detect BOTH the new HOD-prefixed
            // form AND the legacy "-MAN-" / "SWIGGY-…" refs already live in
            // Firestore so older bookings keep unlocking correctly.
            var _isAggRef = /-MAN-/.test(bookingRef) || /^(ZOMATO|SWIGGY|MAGICPIN|EAZYDINER|EAZYDINING|DINEOUT)-/i.test(bookingRef) || /^HOD(SWI|ZOM|MAG|EAZ|DIN|OTH)/i.test(bookingRef);
            if(bookingRef.startsWith('TBL-')||bookingRef.startsWith('AGG-')||bookingRef.startsWith('HODTAB')||_isAggRef){_startTableListener();return;}
            // Guest list entry (legacy GL-… and new HODGL… both routed here)
            // 🔴 2026-05-21 (Khushi LIVE-BUG) — older entries were written with
            // Firestore AUTO-IDs (ref stored only in `ref` field). doc(ref).get()
            // misses them → "Guest list entry not found". Fallback: if doc-id
            // lookup misses, query by `ref` field. Same fallback on .catch().
            if(bookingRef.startsWith('GL-')||bookingRef.startsWith('HODGL')){
              var _glRender=function(gl){
                  inner.innerHTML='';
                  var ev3=(S._cachedEvents||[]).find(function(e){return e.id===gl.eventId;});
                  var glDiv=document.createElement('div');
                  glDiv.style.cssText='padding:20px;max-width:480px;margin:0 auto;';
                  glDiv.innerHTML=
                    '<div style="text-align:center;margin-bottom:24px;">'
                    +'<div style="font-size:48px;margin-bottom:12px;">📋</div>'
                    +'<div style="font-family:var(--ff);font-size:22px;font-weight:900;color:#000;margin-bottom:6px;">Guest List Confirmed</div>'
                    +'<div style="font-size:13px;color:#3D3D3D;">'+(ev3?sanitize(ev3.title):'HOD Event')+'</div>'
                    +'</div>'
                    +'<div style="background:#fff;border:2px solid #000;border-radius:8px;padding:18px;margin-bottom:16px;">'
                    +'<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(0,0,0,.05);"><span style="color:#3D3D3D;font-size:12px;">Guest</span><span style="font-weight:700;font-size:13px;">'+sanitize(gl.name||'')+'</span></div>'
                    +'<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(0,0,0,.05);"><span style="color:#3D3D3D;font-size:12px;">Type</span><span style="font-weight:700;font-size:13px;">'+(gl.type||'stag').toUpperCase()+'</span></div>'
                    +'<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(0,0,0,.05);"><span style="color:#3D3D3D;font-size:12px;">Date</span><span style="font-weight:700;font-size:13px;">'+(ev3?ev3.date:'Tonight')+'</span></div>'
                    +'<div style="display:flex;justify-content:space-between;padding:8px 0;"><span style="color:#3D3D3D;font-size:12px;">Entry</span><span style="font-weight:700;font-size:13px;color:#00C864;">FREE before 9 PM</span></div>'
                    +'</div>'
                    +'<div style="background:#fff;border:2px solid #000;border-radius:8px;padding:20px 16px;margin-bottom:16px;text-align:center;">'
                    /* 🔴 2026-05-21 (Khushi LIVE-BUG) — wrapper bg MUST be #fff.
                       qrcodejs doesn't render a quiet zone, so the dark navy bg
                       made the QR unscannable on every phone. Padded white frame
                       gives the ~4-module quiet zone every scanner requires. */
                    +'<div id="gl-qr-wrap" style="width:140px;height:140px;margin:0 auto 12px;background:#fff;border:8px solid #000;border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 2px 14px rgba(242,199,68,.15);"></div>'
                    +'<div style="font-size:13px;font-weight:800;color:#000;margin-bottom:4px;">Show this QR at the door</div>'
                    +'<div style="font-family:monospace;font-size:14px;color:#000;letter-spacing:2px;">'+sanitize(bookingRef)+'</div>'
                    +'</div>'
                    +'<div style="background:rgba(0,200,100,.06);border:2px solid #23A094;border-radius:8px;padding:18px 20px;text-align:center;">'
                    +'<div style="font-size:24px;margin-bottom:10px;">✅</div>'
                    +'<div style="font-size:14px;font-weight:800;color:#00C864;margin-bottom:6px;">You\'re on the list!</div>'
                    +'<div style="font-size:12px;color:#3D3D3D;line-height:1.7;">Show your QR at the entrance. Free entry before 9 PM.<br>After 9 PM, a cover charge may apply at the door.</div>'
                    +'</div>';
                  inner.appendChild(glDiv);
                  setTimeout(function(){generateLocalQR('gl-qr-wrap','https://hodclub.in/?verify='+encodeURIComponent(bookingRef));},200);
              };
              // 🔴 2026-05-21 (Khushi LIVE-BUG) — guestlist tier picked on the
              // BOOKING page routes through saveBooking() → writes to `bookings`
              // collection (not `guestlist`). So HODGL refs from the booking
              // flow are never found in `guestlist`. Final fallback: query
              // `bookings` by ref and map booking fields → GL render shape.
              //   entryType "guestlist_couple"/"guestlist_female"/"guestlist_stag"
              //   → type "couple"/"ladies"/"stag"
              // `prevErr` flag preserves the explicit "Error loading guest list."
              // message when the upstream guestlist query failed (network /
              // permission). If bookings positively matches, render anyway;
              // if bookings is empty/errors, surface error not "not found".
              var _glFromBooking=function(prevErr){
                firestore.collection('bookings').where('ref','==',bookingRef).limit(1).get()
                  .then(function(bs){
                    if(bs&&!bs.empty){
                      var b=bs.docs[0].data();
                      var _et=(b.entryType||'').toString().toLowerCase().replace('guestlist_','');
                      _glRender({
                        name:b.name||'',eventId:b.eventId||'',
                        type:(_et==='female'?'ladies':(_et||'stag'))
                      });
                    } else if(prevErr){
                      inner.innerHTML='<div style="text-align:center;padding:60px 20px;color:#3D3D3D;">Error loading guest list.</div>';
                    } else {
                      inner.innerHTML='<div style="text-align:center;padding:60px 20px;color:#3D3D3D;">Guest list entry not found.</div>';
                    }
                  })
                  .catch(function(){inner.innerHTML='<div style="text-align:center;padding:60px 20px;color:#3D3D3D;">Error loading guest list.</div>';});
              };
              var _glFallbackByRef=function(){
                firestore.collection('guestlist').where('ref','==',bookingRef).limit(1).get()
                  .then(function(qs){
                    if(qs&&!qs.empty){_glRender(qs.docs[0].data());}
                    else{_glFromBooking(false);}
                  })
                  .catch(function(){_glFromBooking(true);});
              };
              firestore.collection('guestlist').doc(bookingRef).get()
                .then(function(glDoc){
                  if(glDoc.exists){_glRender(glDoc.data());}
                  else{_glFallbackByRef();}
                })
                .catch(function(){_glFallbackByRef();});
              return;
            }
            // No cover yet — look up booking to show ticket info
            firestore.collection('bookings').where('ref','==',bookingRef).limit(1).get().then(function(bkSnap){
              inner.innerHTML='';
              if(!bkSnap.empty){
                var bk=bkSnap.docs[0].data();
                var _isCash=bk.paymentId&&bk.paymentId.startsWith('cash_');
                var ticketDiv=document.createElement('div');
                ticketDiv.style.cssText='padding:20px;max-width:480px;margin:0 auto;';
                ticketDiv.innerHTML=
                  '<div style="text-align:center;margin-bottom:24px;">'+
                    '<div style="font-size:48px;margin-bottom:12px;">🎟️</div>'+
                    '<div style="font-family:var(--ff);font-size:22px;font-weight:900;color:#000;margin-bottom:6px;">Your HOD Ticket</div>'+
                    '<div style="font-size:13px;color:#3D3D3D;">'+sanitize(bk.eventTitle||bk.event||'HOD Event')+'</div>'+
                  '</div>'+
                  '<div style="background:#fff;border:2px solid #000;border-radius:8px;margin-bottom:16px;overflow:hidden;">'+
                    '<table style="width:100%;border-collapse:collapse;font-family:var(--ff);">'+
                      '<tr style="border-bottom:2px solid #000;"><td style="padding:15px 18px;color:#000;font-size:15px;font-weight:800;letter-spacing:.3px;">Guest</td><td style="padding:15px 18px;text-align:right;font-weight:900;font-size:18px;color:#000;">'+sanitize(bk.name||'')+'</td></tr>'+
                      '<tr style="border-bottom:2px solid #000;"><td style="padding:15px 18px;color:#000;font-size:15px;font-weight:800;letter-spacing:.3px;">Entry</td><td style="padding:15px 18px;text-align:right;font-weight:900;font-size:18px;color:#000;">'+(bk.entryType||'stag').toUpperCase()+'</td></tr>'+
                      '<tr style="border-bottom:2px solid #000;"><td style="padding:15px 18px;color:#000;font-size:15px;font-weight:800;letter-spacing:.3px;">Date</td><td style="padding:15px 18px;text-align:right;font-weight:900;font-size:18px;color:#000;">'+sanitize(bk.date||'')+'</td></tr>'+
                      '<tr><td style="padding:15px 18px;color:#000;font-size:15px;font-weight:800;letter-spacing:.3px;">'+(_isCash?'Amount Due':'Paid')+'</td><td style="padding:15px 18px;text-align:right;font-weight:900;font-size:18px;color:'+(_isCash?'#F59E0B':'#00C864')+';">'+(bk.total===0?'FREE':(_isCash?'💵 ₹'+bk.total+' at venue':'₹'+bk.total))+'</td></tr>'+
                    '</table>'+
                  '</div>';
                // QR code
                ticketDiv.innerHTML+=
                  '<div style="background:#fff;border:2px solid #000;border-radius:8px;padding:20px 16px;margin-bottom:16px;text-align:center;">'+
                    /* 🔴 2026-05-21 (Khushi LIVE-BUG) — wrapper bg MUST be #fff.
                       qrcodejs doesn't render a quiet zone, so the dark navy bg
                       made the QR unscannable on every phone. Padded white frame
                       gives the ~4-module quiet zone every scanner requires. */
                    '<div id="ticket-qr-wrap" style="width:140px;height:140px;margin:0 auto 12px;background:#fff;border:8px solid #000;border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 2px 14px rgba(242,199,68,.15);"></div>'+
                    '<div style="font-size:13px;font-weight:800;color:#000;margin-bottom:4px;">Show this QR at the door</div>'+
                    '<div style="font-family:monospace;font-size:14px;color:#000;letter-spacing:2px;">'+sanitize(bookingRef)+'</div>'+
                  '</div>';
                // Wallet activation message
                ticketDiv.innerHTML+=
                  '<div style="background:rgba(242,199,68,.06);border:2px solid #000;border-radius:8px;padding:18px 20px;text-align:center;">'+
                    '<div style="font-size:24px;margin-bottom:10px;">⏳</div>'+
                    '<div style="font-size:14px;font-weight:800;color:#000;margin-bottom:6px;">Your wallet activates at HOD</div>'+
                    '<div style="font-size:12px;color:#3D3D3D;line-height:1.7;">When you arrive, show your QR at the entrance. Our door staff will check you in and activate your cover wallet.<br><br>Your cover balance will be loaded and you can start ordering drinks & food!</div>'+
                  '</div>';
                inner.appendChild(ticketDiv);
                setTimeout(function(){generateLocalQR('ticket-qr-wrap','https://hodclub.in/?verify='+encodeURIComponent(bookingRef));},200);
              } else {
                inner.innerHTML='<div style="text-align:center;padding:60px 20px;">'+
                  '<div style="font-size:48px;margin-bottom:12px;">🎟️</div>'+
                  '<div style="font-size:16px;font-weight:800;color:#000;margin-bottom:8px;">Ticket: '+sanitize(bookingRef)+'</div>'+
                  '<div style="font-size:13px;color:#3D3D3D;line-height:1.7;">Your wallet will be activated when you arrive at HOD.<br>Show your booking reference at the entrance.</div>'+
                '</div>';
              }
            }).catch(function(){
              inner.innerHTML='<div style="text-align:center;padding:60px 20px;color:#3D3D3D;font-size:14px;">Your wallet will be activated at the venue.<br>Show your booking reference at the door.</div>';
            });
            return;
          }
          var doc=snap.docs[0];
          var cv=Object.assign({id:doc.id},doc.data());
          // 🆕 2026-05-27 v3.52 (Khushi LIVE-NIGHT) — REF-PREFIX SAFETY NET.
          // Pre-v3.50 covers docs (activated before the POS bundle that stamps
          // isTableBooking on the covers doc went live) were missing the flag,
          // so HODTAB customers ordering after door-activation fell through to
          // the bartender branch at line ~6515 ("SHOW THIS TO THE BARTENDER").
          // ANY ref starting with HODTAB / TBL- / AGG- is ALWAYS a table
          // booking — the customer site can decide this from the ref alone, no
          // dependency on what the covers doc carries. Force the flag here so
          // every downstream branch (place-order popup, QR sub-copy, AT BAR /
          // AT TABLE picker, _showBartenderQR captain copy at line ~6565) all
          // see isTableBooking=true unconditionally. Fail-safe: only forces TRUE,
          // never overrides a non-table cover, so HODTIC/GL refs are unchanged.
          if (bookingRef && (bookingRef.indexOf('HODTAB')===0 || bookingRef.indexOf('TBL-')===0 || bookingRef.indexOf('AGG-')===0)) {
            cv.isTableBooking = true;
          }
          // For table bookings: if covers doc doesn't have actualArrivalTime yet,
          // check tableReservations as fallback (handles bookings made before the
          // dual-update fix, AND any race conditions during sync).
          // 🆕 2026-06-08 (Khushi) — UNIFY the rounds + resolve the table number.
          // Bar rounds live ONLY on the cover; table rounds get copied to BOTH the
          // cover AND the linked tableReservations doc; captain-placed rounds live
          // ONLY on the table doc. The OLD code REPLACED cv.tabRounds with the table
          // doc's rounds whenever the table doc was longer — which silently WIPED the
          // bar-only rounds and renumbered the bill (Khushi LIVE-BUG: R1 vanished,
          // bill showed "Round 3, Round 2"). We now MERGE (union) both arrays — never
          // drop any round, never renumber — deduping by placedAt|roundNum|roundTotal
          // and sorting by roundNum so the bill always reads in order with every round
          // and its correct 🍸/🍽️ badge. We ALSO pull the table number/floor off the
          // linked doc when the cover's own display fields are blank (so an assigned
          // table always shows; blank only when truly unassigned).
          function _mergeRoundsFromTable(td){
            try{
              if(td && td.actualArrivalTime && !cv.actualArrivalTime) cv.actualArrivalTime=td.actualArrivalTime;
              if(td){
                var _tn=td.tableId||'', _fl=td.floorLabel||'';
                if(_tn){ if(!cv.tableId)cv.tableId=_tn; if(!cv.linkedTableId)cv.linkedTableId=_tn; }
                if(_fl){ if(!cv.floorLabel)cv.floorLabel=_fl; if(!cv.linkedFloorLabel)cv.linkedFloorLabel=_fl; }
              }
              if(td && Array.isArray(td.tabRounds) && td.tabRounds.length){
                var _merged=(Array.isArray(cv.tabRounds)?cv.tabRounds.slice():[]);
                var _seen={}, _k=function(r){return String((r&&r.placedAt)||'')+'|'+String((r&&r.roundNum)||'')+'|'+String((r&&r.roundTotal)||'');};
                _merged.forEach(function(r){_seen[_k(r)]=true;});
                td.tabRounds.forEach(function(r){var kk=_k(r); if(!_seen[kk]){_seen[kk]=true; _merged.push(r);}});
                // 🆕 2026-06-08 v3.253 — sort CHRONOLOGICALLY by placedAt (roundNum is
                // unreliable across writers; the display renumbers 1..N from this order).
                _merged.sort(function(a,b){var at=String((a&&a.placedAt)||''),bt=String((b&&b.placedAt)||''); if(at!==bt)return at.localeCompare(bt); return Number((a&&a.roundNum)||0)-Number((b&&b.roundNum)||0);});
                cv.tabRounds=_merged;
                cv.tabTotal=_merged.reduce(function(s,r){return s+(Number(r&&r.roundTotal)||0);},0);
              } else if(td && td.tabTotal && !cv.tabTotal){ cv.tabTotal=td.tabTotal; }
            }catch(_eMerge){ try{console.warn('[wallet] round merge failed (fail-open)', _eMerge && _eMerge.message);}catch(_){} }
          }
          function _renderCoverCv(){
            // Fetch the linked table doc whenever this cover is bound to one (direct
            // ref preferred; legacy where-query fallback). Fail-open: any error just
            // renders the cover as-is. Released tables are deleted → no doc → cover
            // rounds render alone (correct).
            if(cv.linkedTableRef){
              firestore.collection('tableReservations').doc(cv.linkedTableRef).get().then(function(d){
                _mergeRoundsFromTable(d.exists?(d.data()||null):null);
                renderWalletContent(cv);
              }).catch(function(){renderWalletContent(cv);});
            } else if((cv.isTableBooking||cv.tableId)&&bookingRef){
              firestore.collection('tableReservations').where('bookingRef','==',bookingRef).limit(1).get().then(function(tSnap){
                _mergeRoundsFromTable(tSnap.empty?null:(tSnap.docs[0].data()||null));
                renderWalletContent(cv);
              }).catch(function(){renderWalletContent(cv);});
            } else {
              renderWalletContent(cv);
            }
          }
          // 🆕 2026-06-08 (Khushi LIVE-BUG) — RELEASED-TABLE ZOMBIE COVER.
          // releaseTable() deletes covers/{ref}, but the customer wallet's OWN
          // merge-writes (paymentStatus:'bill_requested', atBar toggle, pendingOrder)
          // RE-CREATE covers/{ref} AFTER release — so a found cover does NOT mean
          // the session is live. The durable release signal is the
          // releasedReservations marker (the same one the table listener honors at
          // ~L2690). The covers listener wins whenever a (zombie) cover exists, so
          // it MUST check the marker too. For TABLE refs, check it FIRST: if
          // released → render the "🙏 Thank you" screen instead of reopening the
          // active wallet. Live sessions never have this marker, so no regression.
          if(bookingRef && (bookingRef.indexOf('TBL-')===0||bookingRef.indexOf('AGG-')===0||bookingRef.indexOf('HODTAB')===0)){
            firestore.collection('releasedReservations').doc(bookingRef).get().then(function(mDoc){
              if(mDoc.exists){
                try{ localStorage.setItem('hod_wallet_visited_'+bookingRef,'1'); }catch(e){}
                inner.innerHTML='<div style="text-align:center;padding:60px 20px;">'
                  +'<div style="font-size:54px;margin-bottom:14px;">🙏</div>'
                  +'<div style="font-family:var(--ff);font-size:22px;font-weight:800;color:#000;margin-bottom:10px;">Thank you for visiting!</div>'
                  +'<div style="font-size:14px;color:#3D3D3D;line-height:1.7;max-width:300px;margin:0 auto 14px;">Your table session has ended. We hope you had a wonderful evening at House of Dopamine.</div>'
                  +'<div style="font-family:monospace;font-size:13px;color:rgba(242,199,68,.55);margin-top:6px;letter-spacing:2px;">'+sanitize(bookingRef)+'</div>'
                  +'<div style="margin-top:24px;font-size:12px;color:#888;">See you again soon ✨</div>'
                +'</div>';
                try{ if(typeof renderHodFeedbackForm==='function') renderHodFeedbackForm(inner, 0); }catch(e){}
                try{ wireCallWaiterFallback(bookingRef); }catch(e){}
                return;
              }
              _renderCoverCv();
            }).catch(function(){ _renderCoverCv(); });
          } else {
            _renderCoverCv();
          }
        },function(e){
          inner.innerHTML='<div style="text-align:center;padding:60px 20px;color:#FF5733;">Error loading wallet: '+sanitize(e.message)+'</div>';
        });
    }
    _startCoversListener('ref');
  } else {
    inner.innerHTML='<div style="text-align:center;padding:60px 20px;color:#3D3D3D;">Connect to load your wallet.</div>';
  }

  return wrap;
}


// ── LOCAL QR FOR MY BOOKINGS
// Size auto-adapts to its container so legacy 140x140 wrappers (#order-qr-popup,
// #ticket-qr-wrap, #gl-qr-wrap) and the new 180x180 wallet wrap both render
// without cropping. Falls back to 140 if container measurement isn't ready.
function generateLocalQR(elId,data){
  setTimeout(function(){
    var qEl=document.getElementById(elId);
    if(qEl&&typeof QRCode!=='undefined'&&!qEl.hasAttribute('data-qr')){
      qEl.setAttribute('data-qr','1');
      var w=qEl.clientWidth||140, h=qEl.clientHeight||140;
      var sz=Math.max(96,Math.min(w,h)-8); // small inner margin so QR never touches edge
      new QRCode(qEl,{text:data,width:sz,height:sz,colorDark:'#000000',colorLight:'#FFFFFF',correctLevel:QRCode.CorrectLevel.M});
    }
  },500);
}

// ════════════════════════════════════════
// P0 / P1 NEW ADMIN FUNCTIONS
// ════════════════════════════════════════

// ── P1: Waitlist Admin Tab
function renderCustomerWallet(bookingRef){
  var wrap=document.createElement('div');
  wrap.style.cssText='margin-top:16px;';

  if(!firestore){wrap.innerHTML='<div style="text-align:center;padding:20px;color:#3D3D3D;">Firebase not connected.</div>';return wrap;}

  firestore.collection('covers').where('ref','==',bookingRef).limit(1).get()
    .then(function(snap){
      wrap.innerHTML='';
      if(snap.empty){
        var pendingDiv=document.createElement('div');
        pendingDiv.style.cssText='padding:12px 16px;border-radius:8px;background:rgba(0,0,0,.03);border:1px solid rgba(0,0,0,.15);font-size:12px;color:#3D3D3D;text-align:center;';
        pendingDiv.textContent='Cover wallet not activated yet. Show QR at door.';
        wrap.appendChild(pendingDiv);return;
      }
      var cv=snap.docs[0].data();
      var bal=cv.coverBalance||0;
      var used=cv.coverUsed||0;
      var total=cv.coverActivated||cv.coverPaid||0;
      // Check if event is over — cover date or expiresAt
      var cvDate=cv.date||cv.eventDate||(cv.activatedAt?cv.activatedAt.split('T')[0]:'');
      var todayStr=new Date().toISOString().split('T')[0];
      var isExpired=(cv.expiresAt&&new Date(cv.expiresAt)<new Date())||(cvDate&&cvDate<todayStr);
      if(isExpired){bal=0;} // show 0 balance for past events
      var pct=total>0?Math.round((used/total)*100):0;

      var walletCard=document.createElement('div');
      walletCard.style.cssText='background:#F4F4F0;border:2px solid #000;border-radius:8px;padding:20px;';
      walletCard.innerHTML='<div style="font-size:10px;font-weight:800;letter-spacing:2px;color:rgba(255,144,232,.7);text-transform:uppercase;margin-bottom:12px;">💰 Cover Wallet</div>'
        +'<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:14px;">'
        +'<div><div style="font-size:11px;color:#3D3D3D;">Remaining</div>'
        +'<div style="font-family:var(--ff);font-size:36px;font-weight:900;color:'+(isExpired?'#FF5733':bal>0?'#FF90E8':'#3D3D3D')+';">₹'+bal.toLocaleString('en-IN')+'</div></div>'
        +'<div style="text-align:right;"><div style="font-size:10px;color:#3D3D3D;">Used</div><div style="font-size:18px;font-weight:800;color:#3D3D3D;">₹'+used.toLocaleString('en-IN')+'</div></div>'
        +'</div>'
        // Progress bar
        +'<div style="height:6px;background:rgba(0,0,0,.15);border-radius:3px;overflow:hidden;margin-bottom:8px;">'
        +'<div style="height:100%;width:'+pct+'%;background:#FF90E8;border-radius:3px;transition:width .4s;"></div></div>'
        +'<div style="display:flex;justify-content:space-between;font-size:10px;color:#3D3D3D;">'
        +'<span>₹'+used.toLocaleString('en-IN')+' used</span>'
        +'<span>₹'+total.toLocaleString('en-IN')+' total cover</span>'
        +'</div>'
        +(isExpired?'<div style="margin-top:10px;font-size:11px;color:#FF5733;font-weight:700;text-align:center;">Cover expired — event has ended</div>':'')
        +'<div style="margin-top:10px;font-size:10px;color:rgba(255,144,232,.5);text-align:center;">Valid for food & drinks tonight only · Show QR to waiter</div>';

      // Transaction history
      if(cv.transactions&&cv.transactions.length){
        var txSection=document.createElement('div');
        txSection.style.cssText='margin-top:12px;';
        var txTitle=document.createElement('div');
        txTitle.style.cssText='font-size:10px;font-weight:800;color:#3D3D3D;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;';
        txTitle.textContent='Transaction History';txSection.appendChild(txTitle);
        cv.transactions.slice().reverse().forEach(function(tx){
          var txRow=document.createElement('div');
          txRow.style.cssText='display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(0,0,0,.04);font-size:12px;';
          txRow.innerHTML='<div><div style="color:#000;font-weight:600;">'+(tx.note||'Item')+'</div>'
            +'<div style="font-size:10px;color:#3D3D3D;">'+(tx.timestamp?new Date(tx.timestamp).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'')+'</div></div>'
            +'<div style="color:#FF5733;font-weight:800;">-₹'+tx.amount+'</div>';
          txSection.appendChild(txRow);
        });
        walletCard.appendChild(txSection);
      }

      wrap.appendChild(walletCard);
    }).catch(function(){});

  return wrap;
}

// ── NIGHT SUMMARY for Analytics
function renderTopUp(bookingId, diffAmt){
  diffAmt = diffAmt || 0;
  var wrap=document.createElement('div');
  wrap.style.cssText='min-height:100vh;background:#F4F4F0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;';

  var hdr3=document.createElement('div');
  hdr3.style.cssText='background:rgba(244,244,240,.95);border-bottom:2px solid #000;padding:14px 20px;display:flex;align-items:center;gap:12px;position:fixed;top:0;left:0;right:0;z-index:100;';
  hdr3.innerHTML='<div style="font-family:var(--ff);font-size:18px;font-weight:900;color:#000;">HOD</div>'
    +'<div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#3D3D3D;">TOP UP COVER</div>';
  wrap.appendChild(hdr3);

  var card=document.createElement('div');
  card.style.cssText='margin-top:70px;width:100%;max-width:380px;background:#fff;border:2px solid #000;border-radius:18px;padding:28px;';
  card.innerHTML='<div style="text-align:center;margin-bottom:20px;">'
    +'<div style="font-size:40px;margin-bottom:10px;">💰</div>'
    +'<div style="font-size:16px;font-weight:900;color:#000;">Top Up Your Cover</div>'
    +'<div style="font-size:12px;color:#3D3D3D;margin-top:4px;">Add more balance to continue enjoying HOD</div>'
    +'</div>';

  var loading=document.createElement('div');
  loading.innerHTML='<div style="text-align:center;padding:20px;color:#3D3D3D;">Loading your balance…</div>';
  card.appendChild(loading);
  wrap.appendChild(card);

  if(!firestore){loading.innerHTML='<div style="color:#FF5733;text-align:center;">Firebase not connected.</div>';return wrap;}

  // Find cover — try direct doc ID first (fast), then fall back to bookingId query
  // The topup URL may contain either the coverDocId or the raw bookingId
  var sanitizedId = bookingId.replace(/[^a-zA-Z0-9_-]/g,'_');
  firestore.collection('covers').doc(sanitizedId).get()
    .then(function(directDoc){
      if(directDoc.exists){
        loading.innerHTML='';
        var cv=directDoc.data();cv.id=directDoc.id;
        renderTopUpContent(card,cv,diffAmt);
      } else {
        // Fallback: query by bookingId field
        return firestore.collection('covers').where('bookingId','==',bookingId).limit(1).get()
          .then(function(snap){
            loading.innerHTML='';
            if(snap.empty){card.innerHTML+='<div style="color:#FF5733;text-align:center;font-size:13px;padding:20px;">Cover not found. Please contact HOD staff.</div>';return;}
            var cv=snap.docs[0].data();cv.id=snap.docs[0].id;
            renderTopUpContent(card,cv,diffAmt);
          });
      }
    })
    .catch(function(){loading.innerHTML='<div style="color:#FF5733;text-align:center;padding:20px;">Error loading cover. Please try again.</div>';});

  return wrap;
}

function renderTopUpContent(card, cv, diffAmt){
      var bal=cv.coverBalance||0;
      var isLockedAmt = diffAmt > 0; // came from cover activation diff link

      // Header card — show different message based on context
      var balDiv=document.createElement('div');
      balDiv.style.cssText='border-radius:12px;padding:16px;margin-bottom:20px;';

      if(isLockedAmt){
        // Diff payment context — clearly show what they owe
        balDiv.style.background='rgba(245,158,11,.08)';
        balDiv.style.border='1px solid rgba(245,158,11,.3)';
        balDiv.innerHTML='<div style="font-size:10px;color:#F59E0B;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">💰 Cover Charge Due</div>'
          +'<div style="font-family:var(--ff);font-size:32px;font-weight:900;color:#F59E0B;margin-bottom:4px;">₹'+diffAmt.toLocaleString('en-IN')+'</div>'
          +'<div style="font-size:12px;color:#3D3D3D;">'+sanitize(cv.name||'')+'  ·  Pay this to activate your ₹'+bal.toLocaleString('en-IN')+' cover wallet</div>';
      } else {
        // Balance exhausted — show current balance (₹0)
        balDiv.style.background='#F4F4F0';
        balDiv.style.border='1px solid rgba(255,144,232,.2)';
        balDiv.innerHTML='<div style="font-size:10px;color:#3D3D3D;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Current Balance</div>'
          +'<div style="font-family:var(--ff);font-size:28px;font-weight:900;color:#000;margin-bottom:4px;">₹'+bal.toLocaleString('en-IN')+'</div>'
          +'<div style="font-size:12px;color:#3D3D3D;">'+sanitize(cv.name||'')+'</div>';
      }
      card.appendChild(balDiv);

      var selectedAmt = isLockedAmt ? diffAmt : 500;

      if(isLockedAmt){
        // Locked mode — single clear payment button, no amount picker
        var lockedNote=document.createElement('div');
        lockedNote.style.cssText='text-align:center;font-size:12px;color:#3D3D3D;margin-bottom:16px;';
        lockedNote.textContent='Your cover charge for tonight is ₹'+diffAmt+'. Tap below to pay.';
        card.appendChild(lockedNote);
      } else {
        // Regular top-up — show amount picker
        var amtLabel=document.createElement('div');
        amtLabel.style.cssText='font-size:11px;font-weight:700;color:#3D3D3D;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;';
        amtLabel.textContent='Select Top-up Amount';card.appendChild(amtLabel);

        var amtGrid=document.createElement('div');
        amtGrid.style.cssText='display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;';
        // ── Helper: deselect every chip (used when user types a custom amount).
        function _clearChipHighlight(){
          Array.from(amtGrid.children).forEach(function(d){
            d.style.borderColor='rgba(0,0,0,.1)';d.style.background='transparent';
            var inner=d.querySelector('div');if(inner)inner.style.color='#3D3D3D';
          });
        }
        [500,1000,1500,2000].forEach(function(amt){
          var btn=document.createElement('div');
          btn.style.cssText='padding:12px;border-radius:8px;border:1.5px solid '+(amt===selectedAmt?'rgba(255,144,232,.6)':'rgba(0,0,0,.1)')+';background:'+(amt===selectedAmt?'#F4F4F0':'transparent')+';text-align:center;cursor:pointer;transition:all .15s;';
          btn.innerHTML='<div style="font-family:var(--ff);font-size:18px;font-weight:900;color:'+(amt===selectedAmt?'#FF90E8':'#3D3D3D')+';">₹'+amt+'</div>';
          btn.onclick=function(){
            selectedAmt=amt;
            _clearChipHighlight();
            btn.style.borderColor='rgba(255,144,232,.6)';btn.style.background='#F4F4F0';
            btn.querySelector('div').style.color='#FF90E8';
            // Clear the custom-amount input so it doesn't show a stale typed value.
            if(_customAmtInput) _customAmtInput.value='';
            if(payBtn) payBtn.textContent='Pay ₹'+selectedAmt.toLocaleString('en-IN')+' →';
          };
          amtGrid.appendChild(btn);
        });
        card.appendChild(amtGrid);

        // ── 2026-05-11 (Khushi feature) — CUSTOM AMOUNT INPUT.
        // Lets the customer type any amount when ₹500/1000/1500/2000 don't fit
        // (e.g. just ₹100 short for a beer, or wants to load ₹3500 for a long
        // night). Min ₹100 (Razorpay min), max ₹50,000 (sanity cap — anything
        // bigger should go through the bartender for cash anyway).
        // FALLBACK: if input is blank or invalid, the chip-selected amount
        // (default ₹500) wins. Customer never gets a "₹0 payment" error.
        var customWrap=document.createElement('div');
        customWrap.style.cssText='margin:4px 0 16px;';
        customWrap.innerHTML='<div style="font-size:10px;font-weight:700;color:#3D3D3D;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Or enter your own amount</div>';
        var customRow=document.createElement('div');
        customRow.style.cssText='display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:8px;border:1.5px solid rgba(0,0,0,.1);background:rgba(0,0,0,.03);';
        customRow.innerHTML='<span style="font-family:var(--ff);font-size:18px;font-weight:900;color:#3D3D3D;">₹</span>';
        var _customAmtInput=document.createElement('input');
        _customAmtInput.type='number';_customAmtInput.min='1';_customAmtInput.max='50000';_customAmtInput.step='1';
        _customAmtInput.placeholder='Enter amount (min ₹1)';
        _customAmtInput.style.cssText='flex:1;background:transparent;border:2px solid #000;outline:none;color:#000;font-family:var(--ff);font-size:18px;font-weight:900;width:100%;';
        _customAmtInput.oninput=function(){
          var v=parseInt(_customAmtInput.value,10);
          if(isNaN(v)||v<1){
            // Invalid / too low → keep chip selection as fallback so payBtn never sends ₹0.
            customRow.style.borderColor='rgba(239,68,68,.4)';
            return;
          }
          if(v>50000){_customAmtInput.value='50000';v=50000;}
          customRow.style.borderColor='rgba(255,144,232,.6)';
          selectedAmt=v;
          _clearChipHighlight();
          if(payBtn) payBtn.textContent='Pay ₹'+v.toLocaleString('en-IN')+' →';
        };
        customRow.appendChild(_customAmtInput);
        customWrap.appendChild(customRow);
        card.appendChild(customWrap);
      }

      var payBtn=document.createElement('button');
      payBtn.style.cssText='width:100%;padding:16px;border-radius:12px;background:#FF90E8;border:2px solid #000;color:#000;font-size:15px;font-weight:900;cursor:pointer;font-family:var(--ff);';
      payBtn.textContent=isLockedAmt?'Pay ₹'+diffAmt.toLocaleString('en-IN')+' →':'Pay & Top Up →';
      payBtn.onclick=function(){
        payBtn.disabled=true;payBtn.textContent='Opening payment…';
        // V4 2026-05-11 — server-verified recharge. Handles BOTH locked-amount
        // diff_paid (table-booking cover charge) AND regular top-up. The server
        // looks at `kind` and clears pendingTopUp + writes diffPaid* on diff_paid;
        // adds to topUpTotal on plain topup. Idempotency handled server-side.
        var _resetBtn=function(){payBtn.disabled=false;payBtn.textContent=isLockedAmt?'Pay ₹'+diffAmt.toLocaleString('en-IN')+' →':'Pay & Top Up →';};
        hodPayAndCredit({
          amount:selectedAmt, coverRef:cv.id, kind:isLockedAmt?'diff_paid':'topup',
          name:cv.name||'', phone:cv.phone||'',
          description: isLockedAmt ? 'Cover charge — '+cv.name : 'Cover Top-up — '+cv.name,
          payBtn:payBtn,
          onSuccess:function(newBal){
            card.innerHTML='<div style="text-align:center;padding:30px 20px;">'
              +'<div style="font-size:56px;margin-bottom:14px;">✅</div>'
              +'<div style="font-size:20px;font-weight:900;color:#00C864;margin-bottom:8px;">'+(isLockedAmt?'Cover Activated!':'Top-up Successful!')+'</div>'
              +'<div style="font-family:var(--ff);font-size:36px;font-weight:900;color:#000;margin-bottom:8px;">₹'+(newBal||0).toLocaleString('en-IN')+'</div>'
              +'<div style="font-size:13px;color:#3D3D3D;">'+(isLockedAmt?'Your cover wallet is ready · Head to the bar!':'New cover balance · Go enjoy HOD! 🎧')+'</div>'
              +'</div>';
          },
          onError:function(msg){
            _resetBtn();
            alert('⚠️ '+msg);
          },
          onClose:_resetBtn
        });
      };
      card.appendChild(payBtn);
}


// Register on window so main-file loader stubs can delegate
window._renderWalletPage = renderWalletPage;
window._renderTopUp = renderTopUp;
window._renderCustomerWallet = renderCustomerWallet;
window._renderWalletContent = renderWalletContent;
console.log("[HOD] wallet.js loaded");
})();
