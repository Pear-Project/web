// pearOS "pay what you want" download gate. Intercepts clicks on any ISO
// download link and offers a Stripe Embedded Checkout modal before the
// download starts. Entering/choosing $0 skips Stripe and downloads
// immediately (throttled). Include with Stripe.js already loaded first.
(function(){
  var STRIPE_PK='pk_live_51NGnKkKJo0lESPTlDtEcHw0Vz9REWIUofe2yc2eGflq2P4397lFszSR9IOZm5VIRns0gVovA9lGUr7nW5XPIJwhj008SkTtvca';
  var CHECKOUT_ENDPOINT='https://iso.pearos.xyz/checkout';
  var FREEPOINT_ENDPOINT='https://iso.pearos.xyz/freepoint';
  var CURRENCY_ENDPOINT='https://iso.pearos.xyz/currency';

  // Derived server-side from the visitor's country (Cloudflare geo, no
  // extra lookup needed) so what's shown here always matches what the
  // /checkout endpoint actually charges. USD/EUR/GBP just reuse the same
  // numeric price with a different symbol (Netflix/Spotify-style display
  // pricing); INR/BRL aren't at parity with USD so they get their own
  // rounded preset amounts from the server instead. Defaults to USD
  // presets until the (very fast, same-edge) lookup resolves.
  var currencySymbol='$';
  var presets=[299,499,999];
  var minCents=100;
  // Paid-only BSD (UltraC0re) builds have their own, much higher floor and
  // presets, in the same currency -- also served by /currency.
  var bsdPresets=[3099,4999,7999];
  var bsdMinCents=3099;
  fetch(CURRENCY_ENDPOINT).then(function(r){ return r.json(); }).then(function(d){
    if(d&&d.symbol) currencySymbol=d.symbol;
    if(d&&Array.isArray(d.presets)&&d.presets.length===3) presets=d.presets;
    if(d&&Number.isFinite(d.minCents)) minCents=d.minCents;
    if(d&&d.bsd){
      if(Array.isArray(d.bsd.presets)&&d.bsd.presets.length===3) bsdPresets=d.bsd.presets;
      if(Number.isFinite(d.bsd.minCents)) bsdMinCents=d.bsd.minCents;
    }
  }).catch(function(){});

  function isBsdHref(href){ return /UltraC0re/i.test(href||''); }

  var CSS='\
.pos-modal-overlay{position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);padding:20px}\
.pos-modal-card{background:var(--popover);color:var(--popover-foreground);border-radius:16px;max-width:420px;width:100%;max-height:90vh;overflow:auto;position:relative;box-shadow:0 24px 60px -24px rgba(0,0,0,.5)}\
.pos-modal-close{position:absolute;top:10px;right:10px;z-index:2;background:var(--muted);color:var(--muted-foreground);border:0;border-radius:999px;width:28px;height:28px;cursor:pointer;font-size:16px;line-height:1;display:flex;align-items:center;justify-content:center}\
.pos-modal-close:hover{background:color-mix(in oklab, var(--accent) 40%, var(--muted))}\
.pos-picker{padding:24px}\
.pos-picker h3{margin:0 0 4px;font-size:1.05rem;font-weight:600}\
.pos-picker p{margin:0 0 16px;color:var(--muted-foreground);font-size:.85rem;line-height:1.4}\
.pos-amt-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;margin-bottom:12px}\
.pos-amt-btn{position:relative;font-family:inherit;cursor:pointer;transition:background .2s,border-color .2s,box-shadow .2s;border-radius:8px;border:1px solid var(--border);background:var(--background);color:inherit;padding:8px 14px;font-size:13px;font-weight:600}\
.pos-amt-btn:hover{background:var(--accent);color:var(--accent-foreground)}\
.pos-amt-btn.selected{border-color:var(--primary);background:color-mix(in oklab, var(--primary) 12%, transparent)}\
.pos-amt-btn.recommended{border:2px solid var(--primary);box-shadow:0 0 0 3px color-mix(in oklab, var(--primary) 15%, transparent)}\
.pos-amt-btn.recommended .pos-badge{position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:var(--primary);color:var(--primary-foreground);font-size:9px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;padding:1px 6px;border-radius:999px;white-space:nowrap}\
.pos-custom-row{display:flex;gap:8px;margin-bottom:14px}\
.pos-custom-input{font-family:inherit;flex:1;min-width:0;border-radius:8px;border:1px solid var(--border);background:transparent;padding:8px 10px;font-size:13px;color:var(--foreground)}\
.pos-go-btn{font-family:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--primary);background:var(--primary);color:var(--primary-foreground);padding:8px 16px;font-size:13px;font-weight:600}\
.pos-go-btn:hover{opacity:.9}\
.pos-skip{display:block;text-align:center;font-size:.8rem;color:var(--muted-foreground);text-decoration:underline;cursor:pointer;background:none;border:0;font-family:inherit;width:100%;padding:4px}\
.pos-badge-inline{display:inline-block;vertical-align:middle;margin-left:6px;background:var(--primary);color:var(--primary-foreground);font-size:9px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;padding:2px 7px;border-radius:999px}\
.pos-error{color:#e11d48;font-size:.8rem;margin:-6px 0 12px}\
.pos-loading{padding:60px 20px;text-align:center;color:var(--muted-foreground);font-size:14px}\
.pos-modal-card.pos-wide{max-width:560px}\
.pos-step{font-size:.7rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted-foreground);margin-bottom:6px}\
.pos-terms-box{height:min(46vh,340px);overflow-y:auto;border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:0 0 10px;font-size:.8rem;line-height:1.55;background:color-mix(in oklab, var(--foreground) 3%, transparent)}\
.pos-terms-box h1{margin:0 0 4px;font-size:1.05rem;font-weight:600;color:var(--foreground)}\
.pos-terms-box h2,.pos-terms-box h3,.pos-terms-box h4{margin:16px 0 4px;font-size:.85rem;font-weight:600;color:var(--foreground)}\
.pos-terms-box p,.pos-terms-box li{margin:0 0 8px;color:var(--muted-foreground);font-size:.8rem;line-height:1.55}\
.pos-terms-box ul{margin:0 0 8px;padding-left:1.2rem;list-style:disc}\
.pos-terms-box a{color:var(--primary);text-decoration:underline}\
.pos-terms-hint{font-size:.75rem;color:var(--muted-foreground);margin:0 0 14px;min-height:1.1em}\
.pos-terms-hint.done{color:var(--primary);font-weight:600}\
.pos-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center}\
.pos-secondary-btn{font-family:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--border);background:var(--background);color:var(--foreground);padding:8px 16px;font-size:13px;font-weight:600}\
.pos-secondary-btn:hover{background:var(--accent);color:var(--accent-foreground)}\
.pos-go-btn:disabled{opacity:.4;cursor:not-allowed}\
.pos-ack{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;margin-bottom:10px;border:1px solid var(--border);border-radius:10px;cursor:pointer;font-size:.82rem;line-height:1.45;color:var(--foreground)}\
.pos-ack input{margin-top:3px;flex:none;width:16px;height:16px;accent-color:var(--primary)}\
.pos-ack.checked{border-color:var(--primary);background:color-mix(in oklab, var(--primary) 8%, transparent)}\
';

  function injectCss(){
    if(document.getElementById('pos-checkout-css')) return;
    var style=document.createElement('style');
    style.id='pos-checkout-css';
    style.textContent=CSS;
    document.head.appendChild(style);
  }

  function buildModal(){
    var overlay=document.createElement('div');
    overlay.className='pos-modal-overlay';
    overlay.id='pos-modal-overlay';
    overlay.hidden=true;
    overlay.innerHTML='<div class="pos-modal-card"><button type="button" class="pos-modal-close" aria-label="Close">&times;</button><div id="pos-modal-body"></div></div>';
    document.body.appendChild(overlay);
    return overlay;
  }

  // e.g. 24900 -> "₹249", 299 -> "$2.99" -- whole units stay whole (INR
  // presets), fractional ones keep two decimals (everything else).
  function fmtAmt(cents){
    var v=cents/100;
    return currencySymbol+(Number.isInteger(v)?String(v):v.toFixed(2));
  }

  // The terms shown in step 1 are the site's own Terms of Use (/terms/),
  // fetched when the step opens -- one source of truth, no copy to keep in
  // sync. Its "Last updated" date is stored on the Stripe charge with the
  // checkout, as a record of which version a buyer accepted.
  var BSD_TERMS_VERSION='tos-unknown';
  // Bump when the wording of the acknowledgement page (step 2) changes.
  var BSD_ACK_VERSION='ack-2026-11-02';

  function bsdTermsHtml(href){
    var arch=/arm64/i.test(href)?'ARM64':(/amd64/i.test(href)?'AMD64':'');
    return '<div class="pos-picker">'
      + '<div class="pos-step">Step 1 of 3 &middot; Terms of Use</div>'
      + '<h3>pearOS UltraC0re'+(arch?' ('+arch+')':'')+' <span class="pos-badge-inline" style="background:var(--destructive);color:#fff">Developer Preview</span></h3>'
      + '<p>Please read the terms to the end. The Agree button unlocks once you reach the bottom.</p>'
      + '<div class="pos-terms-box" id="pos-terms-box" tabindex="0" role="region" aria-label="Terms of Use"><p>Loading the terms&hellip;</p></div>'
      + '<p class="pos-terms-hint" id="pos-terms-hint">Scroll to the end to continue&hellip;</p>'
      + '<div class="pos-actions"><button type="button" class="pos-secondary-btn" id="pos-terms-cancel">Cancel</button><button type="button" class="pos-go-btn" id="pos-terms-agree" disabled>I Agree</button></div>'
      + '</div>';
  }

  // Pulls the article out of /terms/ and returns {html, version}. Classes and
  // inline styles are dropped so it takes the modal's own typography; the
  // "read in Romanian" switch is removed.
  function loadSiteTerms(){
    return fetch('/terms/',{cache:'no-cache'}).then(function(r){
      if(!r.ok) throw new Error('terms '+r.status);
      return r.text();
    }).then(function(html){
      var doc=new DOMParser().parseFromString(html,'text/html');
      var h1=doc.querySelector('main h1');
      var root=h1&&h1.parentElement;
      if(!root) throw new Error('terms layout');
      root=root.cloneNode(true);
      root.querySelectorAll('script,style,iframe,object,embed,form,input,button').forEach(function(n){ n.remove(); });
      root.querySelectorAll('a[href="ro/"],a[href="./ro/"]').forEach(function(n){ var w=n.parentElement; (w&&w!==root?w:n).remove(); });
      root.querySelectorAll('*').forEach(function(n){
        n.removeAttribute('class'); n.removeAttribute('style');
        Array.prototype.slice.call(n.attributes).forEach(function(at){ if(/^on/i.test(at.name)) n.removeAttribute(at.name); });
        if(n.tagName==='A'){ n.target='_blank'; n.rel='noopener'; var h=n.getAttribute('href')||''; if(h.indexOf('javascript:')===0) n.removeAttribute('href'); }
      });
      var m=(root.textContent||'').match(/Last updated:\s*([A-Za-z]+ \d{1,2}, \d{4})/);
      var version='tos-unknown';
      if(m){ var d=new Date(m[1]+' UTC'); if(!isNaN(d.getTime())) version='tos-'+d.toISOString().slice(0,10); }
      return {html:root.innerHTML+'<p><strong>You have reached the end of the terms.</strong></p>', version:version};
    });
  }

  function bsdAckHtml(){
    return '<div class="pos-picker">'
      + '<div class="pos-step">Step 2 of 3 &middot; Before you pay</div>'
      + '<h3>Please confirm you understand</h3>'
      + '<p>All three are required. This is the last step before choosing your amount.</p>'
      + '<label class="pos-ack"><input type="checkbox" class="pos-ack-box"/><span><strong>This is software, and software is not refundable.</strong> It is digital software, not a physical product. I expressly request immediate delivery and understand that payments for software are final and that I lose my 14-day right of withdrawal once my download link is issued.</span></label>'
      + '<label class="pos-ack"><input type="checkbox" class="pos-ack-box"/><span><strong>This is experimental software.</strong> pearOS UltraC0re is a Developer Preview and a work in progress. It can break, lose data or stop working, and it is not meant for daily use.</span></label>'
      + '<label class="pos-ack"><input type="checkbox" class="pos-ack-box"/><span><strong>I know its current limits.</strong> There is no installer and no web browser, rendering is CPU-only (no GPU acceleration in virtual machines), and Wi-Fi, Bluetooth and GPU support are limited.</span></label>'
      + '<div class="pos-actions" style="margin-top:14px"><button type="button" class="pos-secondary-btn" id="pos-ack-back">Back</button><button type="button" class="pos-go-btn" id="pos-ack-continue" disabled>Continue to payment</button></div>'
      + '</div>';
  }

  function bsdPickerHtml(href){
    var s=currencySymbol;
    var arch=/arm64/i.test(href)?'ARM64':(/amd64/i.test(href)?'AMD64':'');
    return '<div class="pos-picker">'
      + '<div class="pos-step">Step 3 of 3 &middot; Payment</div>'
      + '<h3>pearOS UltraC0re'+(arch?' ('+arch+')':'')+' <span class="pos-badge-inline">Developer Preview</span></h3>'
      + '<p>This build is paid-only and unthrottled at full CDN speed. It is a Developer Preview and not ready for daily use. Minimum '+fmtAmt(bsdMinCents)+'.</p>'
      + '<div class="pos-amt-row">'
      + '<button type="button" class="pos-amt-btn selected" data-amount="'+bsdPresets[0]+'">'+fmtAmt(bsdPresets[0])+'</button>'
      + '<button type="button" class="pos-amt-btn" data-amount="'+bsdPresets[1]+'">'+fmtAmt(bsdPresets[1])+'</button>'
      + '<button type="button" class="pos-amt-btn" data-amount="'+bsdPresets[2]+'">'+fmtAmt(bsdPresets[2])+'</button>'
      + '</div>'
      + '<div class="pos-custom-row">'
      + '<input type="number" min="'+(bsdMinCents/100)+'" step="0.01" inputmode="decimal" class="pos-custom-input" id="pos-custom-amount" placeholder="Custom '+s+' (min '+fmtAmt(bsdMinCents)+')"/>'
      + '<button type="button" class="pos-go-btn" id="pos-custom-go">Go</button>'
      + '</div>'
      + '<p class="pos-error" id="pos-error" hidden></p>'
      + '</div>';
  }

  function pickerHtml(href){
    if(isBsdHref(href)) return bsdPickerHtml(href);
    var s=currencySymbol;
    return '<div class="pos-picker">'
      + '<h3>Support independent development</h3>'
      + '<p>Uncap maximum Cloudflare CDN download speeds and directly fund full-time development, updates, and infrastructure for pearOS.</p>'
      + '<div class="pos-amt-row">'
      + '<button type="button" class="pos-amt-btn" data-amount="'+presets[0]+'">'+fmtAmt(presets[0])+'</button>'
      + '<button type="button" class="pos-amt-btn recommended selected" data-amount="'+presets[1]+'"><span class="pos-badge">Popular</span>'+fmtAmt(presets[1])+'</button>'
      + '<button type="button" class="pos-amt-btn" data-amount="'+presets[2]+'">'+fmtAmt(presets[2])+'</button>'
      + '</div>'
      + '<div class="pos-custom-row">'
      + '<input type="number" min="0" step="0.01" inputmode="decimal" class="pos-custom-input" id="pos-custom-amount" placeholder="Custom '+s+'"/>'
      + '<button type="button" class="pos-go-btn" id="pos-custom-go">Go</button>'
      + '</div>'
      + '<p class="pos-error" id="pos-error" hidden></p>'
      + '<button type="button" class="pos-skip" id="pos-skip-btn">No thanks, download free (2 MB/s)</button>'
      + '</div>';
  }

  function init(){
    if(!window.Stripe) return;
    injectCss();
    var overlay=buildModal();
    var body=overlay.querySelector('#pos-modal-body');
    var closeBtn=overlay.querySelector('.pos-modal-close');
    var stripe=Stripe(STRIPE_PK);
    var activeCheckout=null;
    var pendingHref=null;
    var bsdStep=0; // 0 = terms, 1 = acknowledgement, 2 = payment (BSD only)
    var card=overlay.querySelector('.pos-modal-card');

    function closeModal(){
      overlay.hidden=true;
      bsdStep=0;
      card.classList.remove('pos-wide');
      if(activeCheckout){ activeCheckout.destroy(); activeCheckout=null; }
      pendingHref=null;
    }
    closeBtn.addEventListener('click',closeModal);
    overlay.addEventListener('click',function(e){ if(e.target===overlay) closeModal(); });

    // BSD only: terms (Agree unlocks after scrolling to the end), then an
    // acknowledgement page (software / no refunds / experimental), then the
    // usual amount picker and Stripe.
    function showBsdTerms(href){
      pendingHref=href;
      bsdStep=0;
      card.classList.add('pos-wide');
      body.innerHTML=bsdTermsHtml(href);
      overlay.hidden=false;
      var box=body.querySelector('#pos-terms-box');
      var agree=body.querySelector('#pos-terms-agree');
      var hint=body.querySelector('#pos-terms-hint');
      function unlock(){
        agree.disabled=false;
        hint.textContent='Thanks for reading — you can agree now.';
        hint.className='pos-terms-hint done';
      }
      function check(){
        if(!agree.disabled) return;
        if(box.scrollTop+box.clientHeight>=box.scrollHeight-4) unlock();
      }
      box.addEventListener('scroll',check);
      body.querySelector('#pos-terms-cancel').addEventListener('click',closeModal);
      agree.addEventListener('click',function(){ if(!agree.disabled) showBsdAck(href); });
      loadSiteTerms().then(function(t){
        if(bsdStep!==0||overlay.hidden) return;
        BSD_TERMS_VERSION=t.version;
        box.innerHTML=t.html;
        box.scrollTop=0;
        check(); // short content / tall screen: nothing to scroll
      }).catch(function(){
        // Couldn't load /terms/: send them to the page itself, and unlock
        // only once they have opened it.
        box.innerHTML='<p>We could not load the terms here. Please read them on the <a href="https://pearos.xyz/terms/" target="_blank" rel="noopener" id="pos-terms-open">Terms of Use page</a>, then come back and agree.</p>';
        var open=box.querySelector('#pos-terms-open');
        if(open) open.addEventListener('click',function(){ unlock(); });
      });
    }

    function showBsdAck(href){
      bsdStep=1;
      body.innerHTML=bsdAckHtml();
      var boxes=body.querySelectorAll('.pos-ack-box');
      var go=body.querySelector('#pos-ack-continue');
      function update(){
        var all=true;
        boxes.forEach(function(b){
          b.closest('.pos-ack').classList.toggle('checked',b.checked);
          if(!b.checked) all=false;
        });
        go.disabled=!all;
      }
      boxes.forEach(function(b){ b.addEventListener('change',update); });
      body.querySelector('#pos-ack-back').addEventListener('click',function(){ showBsdTerms(href); });
      go.addEventListener('click',function(){
        if(go.disabled) return;
        bsdStep=2;
        showPicker(href);
      });
    }

    function showPicker(href){
      pendingHref=href;
      var bsd=isBsdHref(href);
      if(bsd&&bsdStep<2){ showBsdTerms(href); return; }
      card.classList.remove('pos-wide');
      body.innerHTML=pickerHtml(href);
      overlay.hidden=false;

      var errorEl=body.querySelector('#pos-error');
      function showError(msg){ errorEl.textContent=msg; errorEl.hidden=false; }
      function clearError(){ errorEl.hidden=true; }

      var amtBtns=body.querySelectorAll('.pos-amt-btn');
      var selectedAmount=bsd?bsdPresets[0]:presets[1]; // matches the preset marked "selected" in pickerHtml()
      amtBtns.forEach(function(btn){
        btn.addEventListener('click',function(){
          clearError();
          amtBtns.forEach(function(b){ b.classList.remove('selected'); });
          btn.classList.add('selected');
          selectedAmount=parseInt(btn.getAttribute('data-amount'),10);
          startCheckout(selectedAmount,showError);
        });
      });
      body.querySelector('#pos-custom-go').addEventListener('click',function(){
        clearError();
        var input=body.querySelector('#pos-custom-amount');
        // Empty custom field -- go with whichever preset is currently
        // selected instead of silently doing nothing.
        if(input.value.trim()===''){ startCheckout(selectedAmount,showError); return; }
        var dollars=parseFloat(input.value);
        if(!Number.isFinite(dollars)||dollars<0){ input.focus(); return; }
        startCheckout(Math.round(dollars*100),showError);
      });
      var skipBtn=body.querySelector('#pos-skip-btn');
      if(skipBtn) skipBtn.addEventListener('click',function(){
        openFreeDownload(pendingHref);
      });
    }

    function fileFromHref(href){
      return href.split('/').pop().split('?')[0];
    }

    // Session recordings showed visitors re-clicking Download or navigating
    // back to the builds page minutes later, seemingly unsure whether
    // anything had happened -- window.open() alone gives no on-page
    // confirmation, just a new tab the visitor might not have noticed. This
    // keeps the modal open with an explicit confirmation + manual fallback
    // link instead of silently closing it.
    function startedHtml(url){
      return '<div class="pos-picker" style="text-align:center">'
        + '<h3>Download started</h3>'
        + '<p>Check your browser\'s downloads. If nothing happened, <a href="'+url+'" target="_blank" rel="noopener">click here to open it directly</a>.</p>'
        + '<p>Once it\'s done, verify the SHA256 checksum before installing — <a href="https://support.pearos.xyz/articles/how-to-verify-the-sha256-checksum-on-your-system" target="_blank" rel="noopener noreferrer">here\'s how</a>.</p>'
        + '</div>';
    }

    // Every /iso/ download now requires a valid signed URL (free or paid) --
    // this mints the free-tier one (still throttled) instead of opening the
    // raw, unsigned .iso URL directly.
    function openFreeDownload(href){
      fetch(FREEPOINT_ENDPOINT,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({file:fileFromHref(href)})
      }).then(function(r){ return r.json(); }).then(function(data){
        var url=(data&&data.url)||href;
        window.open(url,'_blank','noopener');
        body.innerHTML=startedHtml(url);
      }).catch(function(){
        window.open(href,'_blank','noopener');
        body.innerHTML=startedHtml(href);
      });
    }

    function startCheckout(amountCents,onError){
      var floor=isBsdHref(pendingHref)?bsdMinCents:minCents;
      if(isBsdHref(pendingHref)){
        // Paid-only: no free path, and nothing below the BSD floor.
        if(amountCents<floor){
          if(onError) onError('Minimum for this build is '+fmtAmt(floor)+'.');
          return;
        }
      } else if(amountCents<=0){
        var href=pendingHref;
        openFreeDownload(href);
        return;
      }
      if(amountCents<floor){
        if(onError) onError('Minimum card amount is '+currencySymbol+(minCents/100).toFixed(2)+'. Choose "download free" instead for no charge.');
        return;
      }
      body.innerHTML='<div class="pos-loading">Loading checkout…</div>';
      fetch(CHECKOUT_ENDPOINT,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({amount_cents:amountCents, file:fileFromHref(pendingHref), terms:isBsdHref(pendingHref)?BSD_TERMS_VERSION:undefined, ack:isBsdHref(pendingHref)?BSD_ACK_VERSION:undefined})
      }).then(function(r){ return r.json(); }).then(function(data){
        if(!data||!data.client_secret){
          body.innerHTML='<div class="pos-loading">Something went wrong. Please try again.</div>';
          return;
        }
        return stripe.initEmbeddedCheckout({clientSecret:data.client_secret}).then(function(checkout){
          activeCheckout=checkout;
          body.innerHTML='<div id="pos-checkout-container"></div>';
          checkout.mount('#pos-checkout-container');
        });
      }).catch(function(){
        body.innerHTML='<div class="pos-loading">Something went wrong. Please try again.</div>';
      });
    }

    document.addEventListener('click',function(e){
      var link=e.target.closest('a[href*="iso.pearos.xyz/iso/"]');
      if(!link) return;
      e.preventDefault();
      showPicker(link.href);
    });
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',init);
  }else{
    init();
  }
})();
