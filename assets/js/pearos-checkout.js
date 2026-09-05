// pearOS "pay what you want" download gate. Intercepts clicks on any ISO
// download link and offers a Stripe Embedded Checkout modal before the
// download starts. Entering/choosing $0 skips Stripe and downloads
// immediately (throttled). Include with Stripe.js already loaded first.
(function(){
  var STRIPE_PK='pk_live_51NGnKkKJo0lESPTlDtEcHw0Vz9REWIUofe2yc2eGflq2P4397lFszSR9IOZm5VIRns0gVovA9lGUr7nW5XPIJwhj008SkTtvca';
  var CHECKOUT_ENDPOINT='https://iso.pearos.xyz/checkout';

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
.pos-error{color:#e11d48;font-size:.8rem;margin:-6px 0 12px}\
.pos-loading{padding:60px 20px;text-align:center;color:var(--muted-foreground);font-size:14px}\
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

  function pickerHtml(){
    return '<div class="pos-picker">'
      + '<h3>Support independent development</h3>'
      + '<p>Uncap maximum Cloudflare CDN download speeds and directly fund full-time development, updates, and infrastructure for pearOS.</p>'
      + '<div class="pos-amt-row">'
      + '<button type="button" class="pos-amt-btn" data-amount="299">$2.99</button>'
      + '<button type="button" class="pos-amt-btn recommended selected" data-amount="499"><span class="pos-badge">Popular</span>$4.99</button>'
      + '<button type="button" class="pos-amt-btn" data-amount="999">$9.99</button>'
      + '</div>'
      + '<div class="pos-custom-row">'
      + '<input type="number" min="0" step="0.01" inputmode="decimal" class="pos-custom-input" id="pos-custom-amount" placeholder="Custom $"/>'
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

    function closeModal(){
      overlay.hidden=true;
      if(activeCheckout){ activeCheckout.destroy(); activeCheckout=null; }
      pendingHref=null;
    }
    closeBtn.addEventListener('click',closeModal);
    overlay.addEventListener('click',function(e){ if(e.target===overlay) closeModal(); });

    function showPicker(href){
      pendingHref=href;
      body.innerHTML=pickerHtml();
      overlay.hidden=false;

      var errorEl=body.querySelector('#pos-error');
      function showError(msg){ errorEl.textContent=msg; errorEl.hidden=false; }
      function clearError(){ errorEl.hidden=true; }

      var amtBtns=body.querySelectorAll('.pos-amt-btn');
      var selectedAmount=499; // matches the preset marked "selected" in pickerHtml()
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
      body.querySelector('#pos-skip-btn').addEventListener('click',function(){
        var href=pendingHref;
        closeModal();
        window.open(href,'_blank','noopener');
      });
    }

    function fileFromHref(href){
      return href.split('/').pop().split('?')[0];
    }

    function startCheckout(amountCents,onError){
      if(amountCents<=0){
        var href=pendingHref;
        closeModal();
        window.open(href,'_blank','noopener');
        return;
      }
      if(amountCents<100){
        if(onError) onError('Minimum card amount is $1.00. Choose "download free" instead for no charge.');
        return;
      }
      body.innerHTML='<div class="pos-loading">Loading checkout…</div>';
      fetch(CHECKOUT_ENDPOINT,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({amount_cents:amountCents, file:fileFromHref(pendingHref)})
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
