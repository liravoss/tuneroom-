// TuneRoom — butterflies.js
(function () {
  var cv = document.getElementById('bg-canvas');
  if (!cv) return;
  var cx = cv.getContext('2d');
  var W, H, bs = [];

  function rsz() { W = cv.width = innerWidth; H = cv.height = innerHeight; }
  rsz(); window.addEventListener('resize', rsz);

  function mkB() {
    return {
      x:   Math.random() * W,
      y:   -30,
      sy:  .28 + Math.random() * .65,
      sx:  (Math.random() - .5) * .4,
      sz:  6 + Math.random() * 11,
      wb:  Math.random() * 6.28,
      ws:  .016 + Math.random() * .022,
      op:  .14 + Math.random() * .4,
      wp:  Math.random() * 6.28,
      wps: .06 + Math.random() * .07
    };
  }

  for (var i = 0; i < 14; i++) {
    var b = mkB();
    b.y = Math.random() * 1080;
    bs.push(b);
  }

  function drawB(b) {
    var w = Math.sin(b.wp) * b.sz;
    cx.save();
    cx.translate(b.x, b.y);
    cx.globalAlpha = b.op;
    cx.shadowColor = '#60a5fa';
    cx.shadowBlur  = 14;
    var g = cx.createRadialGradient(0, 0, 0, 0, 0, b.sz * 1.55);
    g.addColorStop(0, '#bfdbfe');
    g.addColorStop(.5, '#60a5fa');
    g.addColorStop(1, 'rgba(96,165,250,0)');
    cx.fillStyle = g;
    [1, -1].forEach(function (sx) {
      cx.save(); cx.scale(sx, 1);
      cx.beginPath(); cx.moveTo(0, 0);
      cx.bezierCurveTo(w, -b.sz, -b.sz * 1.4, b.sz * .28, 0, b.sz * .4);
      cx.fill();
      cx.beginPath(); cx.moveTo(0, 0);
      cx.bezierCurveTo(w * .65, b.sz * .22, -b.sz * .9, b.sz * 1.1, 0, b.sz * .78);
      cx.fill();
      cx.restore();
    });
    cx.restore();
  }

  function frame() {
    cx.clearRect(0, 0, W, H);
    bs.forEach(function (b) {
      b.y  += b.sy;
      b.x  += b.sx + Math.sin(b.wb) * .35;
      b.wb += b.ws;
      b.wp += b.wps;
      if (b.y > H + 30) Object.assign(b, mkB());
      drawB(b);
    });
    requestAnimationFrame(frame);
  }
  frame();
})();
