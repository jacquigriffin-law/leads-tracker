/* Belt-and-braces: capture ?hero= before JS module loads, handle iOS tap before ready */
(function(){try{
  var h=new URLSearchParams(location.search).get('hero');
  if(['urgent','stale','new'].includes(h))localStorage.setItem('xena-leads-pending-hero-filter',h);
  window.__heroReady=false;
  window.__heroFallback=function(f){
    if(window.__heroReady&&typeof window.applyHeroFilter==='function'){window.applyHeroFilter(f);return;}
    try{localStorage.setItem('xena-leads-pending-hero-filter',f);}catch(e){}
    var u=new URL(location.href);u.searchParams.set('hero',f);location.href=u.toString();
  };
}catch(e){}})();
