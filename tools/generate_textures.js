#!/usr/bin/env node
/**
 * generate_textures.js
 * Generates missing item and block PNG textures (16×16 pixel art).
 * Run once from project root:  node tools/generate_textures.js
 * Pure Node.js — no npm packages required.
 */

'use strict';
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ─── PNG encoder (pure JS) ────────────────────────────────────────────────────

const _CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    _CRC[n] = c;
}
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = _CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
    const len  = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t    = Buffer.from(type, 'ascii');
    const crcv = Buffer.alloc(4);
    crcv.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crcv]);
}
function canvasToPNG(pixels, w, h) {
    const stride = w * 4 + 1;
    const rows   = Buffer.alloc(h * stride);
    for (let y = 0; y < h; y++) {
        rows[y * stride] = 0;
        for (let x = 0; x < w; x++) {
            const s = (y * w + x) * 4;
            const d = y * stride + 1 + x * 4;
            rows[d]   = pixels[s];
            rows[d+1] = pixels[s+1];
            rows[d+2] = pixels[s+2];
            rows[d+3] = pixels[s+3];
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8]=8; ihdr[9]=6; // 8-bit RGBA
    return Buffer.concat([
        Buffer.from([137,80,78,71,13,10,26,10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(rows)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

// ─── Canvas class ────────────────────────────────────────────────────────────

class Canvas {
    constructor(w = 16, h = 16) {
        this.w = w; this.h = h;
        this.d = new Uint8ClampedArray(w * h * 4);
    }
    px(x, y, c) {
        x = Math.round(x); y = Math.round(y);
        if (x < 0 || x >= this.w || y < 0 || y >= this.h || !c || c[3] === 0) return;
        const i = (y * this.w + x) * 4;
        this.d[i]=c[0]; this.d[i+1]=c[1]; this.d[i+2]=c[2]; this.d[i+3]=c[3];
    }
    rect(x, y, w, h, c) {
        for (let dy = 0; dy < h; dy++)
            for (let dx = 0; dx < w; dx++) this.px(x+dx, y+dy, c);
    }
    outline(x, y, w, h, c) {
        for (let dx = 0; dx < w; dx++) { this.px(x+dx,y,c); this.px(x+dx,y+h-1,c); }
        for (let dy = 1; dy < h-1; dy++) { this.px(x,y+dy,c); this.px(x+w-1,y+dy,c); }
    }
    line(x1, y1, x2, y2, c) {
        let dx = Math.abs(x2-x1), dy = Math.abs(y2-y1);
        let sx = x1<x2?1:-1, sy = y1<y2?1:-1, err = dx-dy;
        let x = x1, y = y1;
        while (true) {
            this.px(x,y,c);
            if (x===x2 && y===y2) break;
            const e2=2*err;
            if (e2>-dy){err-=dy;x+=sx;}
            if (e2<dx){err+=dx;y+=sy;}
        }
    }
    // Draw a diagonal band (like a sword blade) from (x1,y1)→(x2,y2), thickness w
    band(x1, y1, x2, y2, w, cFront, cBack) {
        const dx = x2-x1, dy = y2-y1;
        const len = Math.sqrt(dx*dx+dy*dy) || 1;
        const nx = -dy/len, ny = dx/len;
        for (let i = 0; i < w; i++) {
            const o = i - (w-1)/2;
            const xi1 = Math.round(x1+nx*o), yi1 = Math.round(y1+ny*o);
            const xi2 = Math.round(x2+nx*o), yi2 = Math.round(y2+ny*o);
            this.line(xi1, yi1, xi2, yi2, i < w/2 ? cFront : cBack);
        }
    }
    fromTemplate(rows, pal) {
        for (let y = 0; y < rows.length && y < this.h; y++) {
            for (let x = 0; x < rows[y].length && x < this.w; x++) {
                const ch = rows[y][x];
                if (ch !== '.' && pal[ch]) this.px(x, y, pal[ch]);
            }
        }
    }
    save(filepath) {
        fs.mkdirSync(path.dirname(filepath), { recursive: true });
        fs.writeFileSync(filepath, canvasToPNG(this.d, this.w, this.h));
        console.log('  ✓', path.relative(process.cwd(), filepath));
    }
}

// ─── Palette ─────────────────────────────────────────────────────────────────

// Wood material
const WL=[188,143,77,255], WM=[139,90,43,255], WD=[90,55,20,255], WE=[55,30,8,255];
// Stone material
const SL=[185,183,178,255], SM=[135,133,128,255], SD=[85,83,78,255], SE=[45,43,40,255];
// Iron material
const IL=[215,218,228,255], IM=[165,168,178,255], ID=[105,108,118,255], IE=[60,62,72,255];
// Gold material
const GL=[255,225,90,255], GM=[220,178,50,255], GD=[165,128,20,255], GE=[100,75,10,255];
// Handle (brown) — reuse wood
const H1=WL, H2=WM, H3=WD;
// Crossguard color
const CG=[200,160,40,255];
// Leather
const LL=[195,140,80,255], LM=[155,100,45,255], LD=[100,60,20,255];
// Skin (food)
const SK=[245,220,180,255];
// Red meat
const RM=[200,50,40,255], RC=[160,80,40,255];
// Cooked
const CK=[140,90,40,255], CKL=[175,125,65,255];
// Pink
const PK=[230,160,145,255];
// Green
const GR=[50,165,40,255], GRL=[90,205,70,255];
// White/grey
const WW=[240,240,240,255], GY=[160,160,160,255], GYD=[100,100,100,255];
// Brown bread
const BN=[185,135,60,255], BNL=[215,175,100,255], BND=[140,90,30,255];
// Blue (fish)
const BL=[90,130,200,255], BLD=[60,90,150,255], FISHC=[165,120,60,255];
// Fire
const F1=[220,80,20,255], F2=[255,150,0,255], F3=[255,210,50,255];
// Planks
const PL=[195,155,90,255], PM=[160,120,55,255], PD=[120,85,35,255];
// Metal dark for blocks
const MB=[80,80,80,255], ML=[150,150,150,255], MH=[200,200,200,255];
// Dark outline
const DK=[20,20,20,255];
// Trans
const TP=[0,0,0,0];

// ─── Helper: save if file doesn't exist (skip) or overwrite ──────────────────

function save(c, filepath) {
    c.save(filepath);
}

// ─── Tool drawing functions ───────────────────────────────────────────────────

function drawSword(ml, mm, md) {
    const c = new Canvas();
    // Blade: diagonal from (14,1) to (7,8)
    c.band(14, 1, 8, 7, 2, ml, mm);
    c.px(14,0,ml); c.px(15,1,ml);  // tip
    // Crossguard: horizontal band at y=7,8
    c.rect(3, 7, 6, 2, CG);
    c.px(2,7,GD); c.px(9,7,GD); c.px(2,8,GD); c.px(9,8,GD);
    // Handle: diagonal from (6,9) to (2,13)
    c.line(6,9,3,12,H2);
    c.line(7,9,4,12,H1);
    c.px(2,13,H3); c.px(3,13,H2);
    return c;
}

function drawPickaxe(ml, mm, md) {
    const c = new Canvas();
    // Handle: diagonal from (12,12) to (3,3)
    c.band(12,12,4,4,2,H1,H2);
    // Axe head: a bent shape at top-left
    c.rect(2,2,5,2,mm); c.rect(2,4,2,3,mm);   // left prong
    c.rect(7,3,4,2,ml); c.px(11,3,mm);         // right (pick) end
    c.rect(4,3,4,2,ml);
    // Darker inner detail
    c.px(3,3,md); c.px(3,4,md); c.px(3,5,md); c.px(4,5,md);
    c.px(9,3,mm); c.px(10,3,mm); c.px(11,4,mm);
    return c;
}

function drawAxe(ml, mm, md) {
    const c = new Canvas();
    // Handle diagonal
    c.band(12,13,5,6,2,H1,H2);
    // Axe head top-left
    c.rect(2,2,6,5,mm);
    c.rect(2,2,6,2,ml);
    c.px(2,2,md); c.px(2,3,md); c.px(2,4,md); c.px(2,5,md); c.px(2,6,md);
    c.px(7,4,md); c.px(7,5,md); c.px(7,6,md);
    // Notch at bottom of head
    c.px(5,7,mm); c.px(6,6,mm);
    return c;
}

function drawShovel(ml, mm, md) {
    const c = new Canvas();
    // Handle down the middle
    c.line(8,5,8,14,H1); c.line(7,5,7,14,H2);
    // Shovel head at top
    c.rect(5,1,6,4,mm);
    c.rect(5,1,6,1,ml);
    c.px(5,1,md); c.px(5,2,md); c.px(5,3,md); c.px(5,4,md);
    c.px(10,1,md); c.px(10,2,md); c.px(10,3,md); c.px(10,4,md);
    return c;
}

function drawSpear(ml, mm, md) {
    const c = new Canvas();
    // Shaft diagonal from bottom-left to top-right
    c.band(3,13,11,5,2,H1,H2);
    // Tip (triangle) at top-right
    c.px(13,2,ml); c.px(14,1,ml); c.px(14,2,ml);
    c.px(13,3,mm); c.px(14,3,mm); c.px(12,3,mm);
    c.px(13,4,mm); c.px(12,4,md);
    c.px(12,5,mm);
    return c;
}

// ─── Armor drawing ────────────────────────────────────────────────────────────

function drawHelmet(al, am, ad) {
    const c = new Canvas();
    c.rect(3,4,10,6,am);
    c.rect(4,3,8,2,am);
    c.rect(3,4,10,2,al); // top highlight
    c.px(3,4,ad); c.px(12,4,ad); // side shadow
    c.rect(3,9,2,2,ad);  // left earpiece
    c.rect(11,9,2,2,ad); // right earpiece
    // Visor slot
    c.rect(4,6,8,2,ad);
    c.rect(5,6,6,1,DK);
    return c;
}

function drawChestplate(al, am, ad) {
    const c = new Canvas();
    c.rect(2,4,12,9,am);
    c.rect(2,4,12,2,al);
    c.px(2,4,ad); c.px(13,4,ad); c.px(2,12,ad); c.px(13,12,ad);
    // Neck cutout
    c.rect(5,3,6,3,TP);
    // Lines detail
    c.line(2,7,13,7,ad);
    c.line(2,10,13,10,ad);
    // Arm cutout effect
    c.px(2,4,al); c.px(13,4,al);
    return c;
}

function drawLeggings(al, am, ad) {
    const c = new Canvas();
    c.rect(2,2,12,6,am);
    c.rect(2,2,12,2,al);
    // Left leg
    c.rect(2,8,5,6,am);
    c.rect(2,8,5,1,al);
    c.px(2,13,ad); c.px(6,13,ad);
    // Right leg
    c.rect(9,8,5,6,am);
    c.rect(9,8,5,1,al);
    c.px(9,13,ad); c.px(13,13,ad);
    // Belt/waist line
    c.line(2,7,13,7,ad);
    return c;
}

function drawBoots(al, am, ad) {
    const c = new Canvas();
    // Left boot
    c.rect(2,3,5,8,am);
    c.rect(2,3,5,2,al);
    c.rect(1,9,6,3,am); // sole/toe
    c.rect(1,11,6,1,ad);
    // Right boot
    c.rect(9,3,5,8,am);
    c.rect(9,3,5,2,al);
    c.rect(8,9,6,3,am);
    c.rect(8,11,6,1,ad);
    return c;
}

// ─── Quiver ───────────────────────────────────────────────────────────────────

function drawQuiver(ql, qm, qd) {
    const c = new Canvas();
    // Quiver body (tall rectangle)
    c.rect(5,2,6,12,qm);
    c.rect(5,2,6,2,ql);
    c.px(5,13,qd); c.px(10,13,qd);
    // Arrows sticking out the top
    c.line(6,0,6,4,GY); c.px(6,0,WW);
    c.line(8,0,8,4,GY); c.px(8,0,WW);
    c.line(10,0,10,4,GY); c.px(10,0,WW);
    // Belt strap detail
    c.line(5,6,10,6,qd);
    c.line(5,9,10,9,qd);
    return c;
}

// ─── Block item faces ─────────────────────────────────────────────────────────

function blockFace(tl, tm, td, te) {
    const c = new Canvas();
    c.rect(0,0,16,16,tm);
    // Add some noise/texture detail
    for (let y = 0; y < 16; y += 4) {
        for (let x = 0; x < 16; x += 4) {
            if ((x+y) % 8 === 0) c.rect(x,y,2,2,tl);
            else if ((x+y) % 6 === 0) c.rect(x,y,2,2,td);
        }
    }
    c.outline(0,0,16,16,te);
    return c;
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

const ITEMS  = 'data/textures/items';
const BLOCKS = 'data/textures/blocks';

console.log('\n─── Item textures ───');

// ── Stick ──
(function() {
    const c = new Canvas();
    c.band(13,1,3,11,2,WL,WM);
    c.px(13,1,WL); c.px(14,1,WL);
    c.px(2,12,WD); c.px(3,12,WM);
    save(c, `${ITEMS}/stick.png`);
})();

// ── Flint ──
(function() {
    const c = new Canvas();
    c.fromTemplate([
        '................',
        '....DDDDD.......',
        '...DDDDDDDD.....',
        '..DDDLDDDDDD....',
        '..DDDLLDDDDDD...',
        '...DDDDDDDDDD...',
        '....DDDDDDDDD...',
        '.....DDDDDDDD...',
        '......DDDDDDD...',
        '.......DDDDDD...',
        '........DDDDD...',
        '.........DDDD...',
        '..........DDD...',
        '...........DD...',
        '................',
        '................',
    ], { D: GYD, L: GY });
    save(c, `${ITEMS}/flint.png`);
})();

// ── Leather ──
(function() {
    const c = new Canvas();
    c.fromTemplate([
        '................',
        '....MMMMMM......',
        '...MMMLLMMM.....',
        '..MMMLLLLLMM....',
        '..MMLLLLLLLM....',
        '..MMLLLLLLLM....',
        '..MMLLLLLLLM....',
        '...MMMLLMMM.....',
        '....MMMMM.......',
        '....MM.MM.......',
        '...MMM.MMM......',
        '..MMM...MMM.....',
        '..MM.....MM.....',
        '................',
        '................',
        '................',
    ], { L: LL, M: LM });
    save(c, `${ITEMS}/leather.png`);
})();

// ── String ──
(function() {
    const c = new Canvas();
    c.fromTemplate([
        '..W.............',
        '...W............',
        '....W...........',
        '....W...........',
        '...W............',
        '..W.............',
        '..W.............',
        '...W............',
        '....W...........',
        '.....W..........',
        '.....W..........',
        '....W...........',
        '...W............',
        '..W.............',
        '...W............',
        '................',
    ], { W: WW });
    save(c, `${ITEMS}/string.png`);
})();

// ── Wool ──
(function() {
    const c = new Canvas();
    c.rect(2,2,12,12,WW);
    c.rect(2,2,12,1,[220,220,220,255]);
    c.outline(2,2,12,12,GY);
    // Fluffy texture
    for (let y=3;y<14;y+=3) c.line(2,y,13,y,GY);
    for (let x=3;x<14;x+=3) c.line(x,2,x,13,GY);
    save(c, `${ITEMS}/wool.png`);
})();

// ── Apple ──
(function() {
    const c = new Canvas();
    c.fromTemplate([
        '....G...........',
        '...GG...........',
        '..RRRRRR........',
        '.RRRRRRRR.......',
        '.RRRRRRRRR......',
        'RRRRRRRRRR......',
        'RRRRRRRRRR......',
        'RRRRRRRRRR......',
        '.RRRRRRRRR......',
        '.RRRRRRRR.......',
        '..RRRRRR........',
        '...RRRR.........',
        '................',
        '................',
        '................',
        '................',
    ], { R: [200,50,40,255], G: [50,160,40,255] });
    save(c, `${ITEMS}/apple.png`);
})();

// ── Arrow ──
(function() {
    const c = new Canvas();
    c.fromTemplate([
        '......W.........',
        '.....WWW........',
        '....WWWWW.......',
        '.....WFF........',
        '......F.........',
        '......F.........',
        '......F.........',
        '......F.........',
        '......F.........',
        '......F.........',
        '......F.........',
        '......F.........',
        '.....FFF........',
        '....F.F.F.......',
        '................',
        '................',
    ], { W: WW, F: [160,130,90,255] });
    save(c, `${ITEMS}/arrow.png`);
})();

// ── Bread ──
(function() {
    const c = new Canvas();
    c.fromTemplate([
        '................',
        '...BBBBBBB......',
        '..BLLLLLLBB.....',
        '.BLLLLLLLLLB....',
        '.BLLLLLLLLBB....',
        '.BLLLLLLLLB.....',
        '.BLLLLLLLLB.....',
        '.BLLLLLLLLB.....',
        '.BBBBBBBBB......',
        '................',
        '................',
        '................',
        '................',
        '................',
        '................',
        '................',
    ], { L: BNL, B: BN });
    save(c, `${ITEMS}/bread.png`);
})();

// ── Raw beef ──
(function() {
    const c = new Canvas();
    c.fromTemplate([
        '...RRRR.........',
        '..RRRRRRRR......',
        '.RRRPPRRRRR.....',
        '.RRRRPRRRRRR....',
        'RRRRRPRRRRRR....',
        'RRRRPRRRRRRR....',
        '.RRRRRRRRRRR....',
        '.RRRRRRRRRR.....',
        '..RRRRRRR.......',
        '...RRRRR........',
        '................',
        '................',
        '................',
        '................',
        '................',
        '................',
    ], { R: RM, P: PK });
    save(c, `${ITEMS}/raw_beef.png`);
})();

// ── Cooked beef ──
(function() {
    const c = new Canvas();
    c.fromTemplate([
        '...CCCC.........',
        '..CCCCCCCC......',
        '.CCCCDDCCCC.....',
        '.CCCCDDCCCCC....',
        'CCCCCDDCCCCC....',
        'CCCCDDCCCCCC....',
        '.CCCCCCCCCCC....',
        '.CCCCCCCCCC.....',
        '..CCCCCCC.......',
        '...CCCCC........',
        '................',
        '................',
        '................',
        '................',
        '................',
        '................',
    ], { C: CK, D: CKL });
    save(c, `${ITEMS}/cooked_beef.png`);
})();

// ── Raw chicken ──
(function() {
    const c = new Canvas();
    c.fromTemplate([
        '...PPPP.........',
        '..PPPPPPPP......',
        '.PPPPPPPPPP.....',
        '.PPPSSKPPPPP....',
        'PPPPSSKPPPPPP...',
        'PPPPPPPPPPPPP...',
        '.PPPPPPPPPPPP...',
        '.PPPPPPPPPP.....',
        '..PPPPPPPP......',
        '...PPPPP........',
        '................',
        '................',
        '................',
        '................',
        '................',
        '................',
    ], { P: PK, S: SK, K: [240,200,160,255] });
    save(c, `${ITEMS}/raw_chicken.png`);
})();

// ── Cooked chicken ──
(function() {
    const c = new Canvas();
    c.fromTemplate([
        '...CCCC.........',
        '..CCCCCCCC......',
        '.CCCCCCCCCC.....',
        '.CCCDDLCCCC.....',
        'CCCCDDLCCCCC....',
        'CCCCCCCCCCCCC...',
        '.CCCCCCCCCCCC...',
        '.CCCCCCCCCC.....',
        '..CCCCCCCC......',
        '...CCCCC........',
        '................',
        '................',
        '................',
        '................',
        '................',
        '................',
    ], { C: CK, D: CKL, L: BNL });
    save(c, `${ITEMS}/cooked_chicken.png`);
})();

// ── Raw pork ──
(function() {
    const c = new Canvas();
    c.fromTemplate([
        '..RRRRR.........',
        '.RRRRRRRR.......',
        'RRRPPPPRRR......',
        'RRPPPPPPRRR.....',
        'RRRPPPPRRRRR....',
        '.RRRRRRRRRR.....',
        '.RRRRRRRRR......',
        '..RRRRRRR.......',
        '...RRRR.........',
        '................',
        '................',
        '................',
        '................',
        '................',
        '................',
        '................',
    ], { R: RM, P: PK });
    save(c, `${ITEMS}/raw_pork.png`);
})();

// ── Cooked pork ──
(function() {
    const c = new Canvas();
    c.fromTemplate([
        '..CCCCC.........',
        '.CCCCCCCC.......',
        'CCCDDDDCCC......',
        'CCDDDDDDCCC.....',
        'CCCDDDDCCCCC....',
        '.CCCCCCCCCCC....',
        '.CCCCCCCCC......',
        '..CCCCCCC.......',
        '...CCCC.........',
        '................',
        '................',
        '................',
        '................',
        '................',
        '................',
        '................',
    ], { C: CK, D: CKL });
    save(c, `${ITEMS}/cooked_pork.png`);
})();

// ── Raw fish ──
(function() {
    const c = new Canvas();
    c.fromTemplate([
        '................',
        '..BBL...........',
        '.BBBBLLL........',
        'BBBBBBBLL.......',
        'BBBBBBBBBLLL....',
        '.BBBBBBBBBLL....',
        '..BBBBBBBLL.....',
        '...BBBBBLL......',
        '...BBBBLL.......',
        '....BBBLL.......',
        '.....BBB........',
        '......B.B.......',
        '................',
        '................',
        '................',
        '................',
    ], { B: BL, L: BLD });
    save(c, `${ITEMS}/raw_fish.png`);
})();

// ── Cooked fish ──
(function() {
    const c = new Canvas();
    c.fromTemplate([
        '................',
        '..CCL...........',
        '.CCCCLL.........',
        'CCCCCCCL........',
        'CCCCCCCCCLL.....',
        '.CCCCCCCCLL.....',
        '..CCCCCCCL......',
        '...CCCCLL.......',
        '...CCCCL........',
        '....CCCL........',
        '.....CCC........',
        '......C.C.......',
        '................',
        '................',
        '................',
        '................',
    ], { C: FISHC, L: CK });
    save(c, `${ITEMS}/cooked_fish.png`);
})();

// ── Bow ──
(function() {
    const c = new Canvas();
    c.fromTemplate([
        '..W.............',
        '..WW............',
        '..WBW...........',
        '..WBBW..........',
        '..WBBBW.........',
        '..WBBBBW........',
        '..WBBBBBW.......',
        '..WBBBBBBW......',
        '..WBBBBBW.......',
        '..WBBBBW........',
        '..WBBBW.........',
        '..WBBW..........',
        '..WBW...........',
        '..WW............',
        '..W.............',
        '................',
    ], { W: WM, B: [210,210,210,255] });
    save(c, `${ITEMS}/bow.png`);
})();

// ── Iron shield ──
(function() {
    const c = new Canvas();
    c.fromTemplate([
        '................',
        '...IIIIIIIII....',
        '..IIIIIIIIIII...',
        '.IIIIIGGIIIIII..',
        '.IIIGGGGGGIIII..',
        '.IIIGGGGGGIII...',
        '.IIIIGGGGIII....',
        '.IIIIIGGIIII....',
        '.IIIIIIIIIII....',
        '..IIIIIIIIII....',
        '..IIIIIIIII.....',
        '...IIIIIII......',
        '....IIIII.......',
        '.....III........',
        '......I.........',
        '................',
    ], { I: IM, G: GM });
    save(c, `${ITEMS}/iron_shield.png`);
})();

// ── Tools ────────────────────────────────────────────────────────────────────

console.log('\n─── Tools ───');

const TOOL_MATS = [
    { prefix: 'wooden',  l: WL, m: WM, d: WD },
    { prefix: 'stone',   l: SL, m: SM, d: SD },
    { prefix: 'iron',    l: IL, m: IM, d: ID },
    { prefix: 'gold',    l: GL, m: GM, d: GD },
];

for (const mat of TOOL_MATS) {
    save(drawSword(mat.l, mat.m, mat.d),    `${ITEMS}/${mat.prefix}_sword.png`);
    save(drawPickaxe(mat.l, mat.m, mat.d),  `${ITEMS}/${mat.prefix}_pickaxe.png`);
    save(drawAxe(mat.l, mat.m, mat.d),      `${ITEMS}/${mat.prefix}_axe.png`);
    save(drawShovel(mat.l, mat.m, mat.d),   `${ITEMS}/${mat.prefix}_shovel.png`);
    save(drawSpear(mat.l, mat.m, mat.d),    `${ITEMS}/${mat.prefix}_spear.png`);
}

// ── Armor ─────────────────────────────────────────────────────────────────────

console.log('\n─── Armor ───');

const ARMOR_MATS = [
    { prefix: 'leather', l: LL, m: LM, d: LD },
    { prefix: 'iron',    l: IL, m: IM, d: ID },
    { prefix: 'gold',    l: GL, m: GM, d: GD },
];

for (const mat of ARMOR_MATS) {
    save(drawHelmet(mat.l, mat.m, mat.d),     `${ITEMS}/${mat.prefix}_helmet.png`);
    save(drawChestplate(mat.l, mat.m, mat.d), `${ITEMS}/${mat.prefix}_chestplate.png`);
    save(drawLeggings(mat.l, mat.m, mat.d),   `${ITEMS}/${mat.prefix}_leggings.png`);
    save(drawBoots(mat.l, mat.m, mat.d),      `${ITEMS}/${mat.prefix}_boots.png`);
}

// Quivers
save(drawQuiver(IL, IM, ID), `${ITEMS}/iron_quiver.png`);
save(drawQuiver(LL, LM, LD), `${ITEMS}/leather_quiver.png`);

// ── Ingots ──────────────────────────────────────────────────────────────────

(function() {
    const iron = new Canvas();
    iron.rect(3,5,10,6,IM); iron.rect(3,5,10,2,IL); iron.rect(3,10,10,1,ID);
    iron.rect(3,5,1,6,ID); iron.rect(12,5,1,6,ID);
    // shine streak
    iron.line(5,6,9,6,IL); iron.line(5,7,7,7,IL);
    save(iron, `${ITEMS}/iron_ingot.png`);
})();

(function() {
    const gold = new Canvas();
    gold.rect(3,5,10,6,GM); gold.rect(3,5,10,2,GL); gold.rect(3,10,10,1,GD);
    gold.rect(3,5,1,6,GD); gold.rect(12,5,1,6,GD);
    gold.line(5,6,9,6,GL); gold.line(5,7,7,7,GL);
    save(gold, `${ITEMS}/gold_ingot.png`);
})();

// ── Block items (chest, crafting_table, oven, smelter, anvil) ─────────────────

console.log('\n─── Block items + block textures ───');

// Chest item
(function() {
    const c = new Canvas();
    c.rect(1,4,14,9,WM);
    c.rect(1,4,14,1,WL);
    c.rect(1,12,14,1,WD);
    c.px(1,4,WD); c.px(14,4,WD); c.px(1,12,WD); c.px(14,12,WD);
    // Metal band
    c.rect(1,7,14,1,IM);
    c.rect(1,8,14,1,ID);
    // Latch
    c.rect(6,6,4,3,GM); c.rect(7,7,2,1,GD);
    save(c, `${ITEMS}/chest.png`);
})();

// Crafting table item
(function() {
    const c = new Canvas();
    // Oak plank base
    c.rect(1,1,14,14,PM);
    c.rect(1,1,14,2,PL);
    c.rect(1,14,14,1,PD);
    // Grid lines (3x3 crafting pattern)
    c.line(1,5,14,5,PD); c.line(1,10,14,10,PD);
    c.line(5,1,5,14,PD); c.line(10,1,10,14,PD);
    save(c, `${ITEMS}/crafting_table.png`);
})();

// Oven item
(function() {
    const c = new Canvas();
    c.rect(1,1,14,14,SM);
    c.rect(1,1,14,2,SL);
    c.rect(1,14,14,1,SD);
    // Fire window
    c.rect(4,5,8,6,DK);
    c.rect(5,6,2,4,F2); c.rect(7,6,2,4,F1); c.rect(9,6,2,4,F2);
    c.px(6,5,F3); c.px(8,5,F3); c.px(7,5,F2);
    save(c, `${ITEMS}/oven.png`);
})();

// Smelter item
(function() {
    const c = new Canvas();
    c.rect(1,1,14,14,SD);
    c.rect(1,1,14,2,SM);
    c.rect(1,14,14,1,SE);
    // Hot metal window
    c.rect(4,4,8,7,DK);
    c.rect(5,5,6,5,[200,100,20,255]);
    c.rect(6,6,4,3,[240,140,20,255]);
    c.rect(7,7,2,1,[255,200,50,255]);
    save(c, `${ITEMS}/smelter.png`);
})();

// Anvil item
(function() {
    const c = new Canvas();
    // Anvil shape
    c.rect(2,3,12,3,GY);  // top flat
    c.rect(2,3,12,1,MH);  // top highlight
    c.rect(4,6,8,2,GYD);  // neck
    c.rect(1,8,14,5,GY);  // base
    c.rect(1,8,14,1,MH);  // base highlight
    c.rect(1,12,14,1,GYD);  // base bottom
    // Horn (left)
    c.rect(2,4,3,2,GY);
    save(c, `${ITEMS}/anvil.png`);
})();

// ── Block face textures (for 3D world) ───────────────────────────────────────

// Crafting Table
(function() {
    // Top: grid on oak planks
    const top = new Canvas();
    top.rect(0,0,16,16,PM);
    top.rect(0,0,16,2,PL); top.rect(0,14,16,2,PD);
    top.line(0,7,15,7,PD); top.line(0,8,15,8,PL);
    top.line(7,0,7,15,PD); top.line(8,0,8,15,PL);
    save(top, `${BLOCKS}/Crafting_Table_Top.png`);

    // Side: wood planks with tool marks
    const side = new Canvas();
    side.rect(0,0,16,16,PM);
    side.rect(0,0,16,2,PL); side.rect(0,14,16,2,PD);
    side.line(4,0,4,15,PD); side.line(5,0,5,15,PL);
    side.line(11,0,11,15,PD); side.line(12,0,12,15,PL);
    save(side, `${BLOCKS}/Crafting_Table_Side.png`);
})();

// Oven
(function() {
    const front = new Canvas();
    front.rect(0,0,16,16,SM);
    front.rect(0,0,16,2,SL); front.rect(0,14,16,2,SD);
    // Fire opening
    front.rect(3,4,10,8,DK);
    front.rect(4,5,8,6,F1);
    front.rect(5,6,6,4,F2);
    front.rect(6,7,4,2,F3);
    front.rect(7,7,2,1,[255,230,80,255]);
    save(front, `${BLOCKS}/Oven_Front.png`);

    const side = new Canvas();
    side.rect(0,0,16,16,SM);
    side.rect(0,0,16,2,SL); side.rect(0,14,16,2,SD);
    side.line(5,0,5,15,SD); side.line(10,0,10,15,SD);
    save(side, `${BLOCKS}/Oven_Side.png`);

    const top = new Canvas();
    top.rect(0,0,16,16,SM);
    top.rect(0,0,16,2,SL);
    top.rect(5,5,6,6,SD); top.rect(6,6,4,4,DK);
    save(top, `${BLOCKS}/Oven_Top.png`);
})();

// Smelter
(function() {
    const front = new Canvas();
    front.rect(0,0,16,16,SD);
    front.rect(0,0,16,2,SM); front.rect(0,14,16,2,SE);
    // Molten metal opening
    front.rect(3,4,10,8,DK);
    front.rect(4,5,8,6,[180,80,10,255]);
    front.rect(5,6,6,4,[220,120,20,255]);
    front.rect(6,7,4,2,[255,170,30,255]);
    save(front, `${BLOCKS}/Smelter_Front.png`);

    const side = new Canvas();
    side.rect(0,0,16,16,SD);
    side.rect(0,0,16,2,SM); side.rect(0,14,16,2,SE);
    side.line(5,0,5,15,SE); side.line(10,0,10,15,SE);
    save(side, `${BLOCKS}/Smelter_Side.png`);

    save(blockFace(SM, SD, SE, SE), `${BLOCKS}/Smelter_Top.png`);
})();

// Chest block faces
(function() {
    const front = new Canvas();
    front.rect(0,0,16,16,WM);
    front.rect(0,0,16,2,WL); front.rect(0,14,16,2,WD);
    // Metal band
    front.rect(0,7,16,2,IM);
    // Latch
    front.rect(5,5,6,5,GM); front.rect(6,6,4,3,GD);
    front.rect(7,7,2,1,GM);
    // Wood plank lines
    front.line(0,4,15,4,WD); front.line(0,12,15,12,WD);
    save(front, `${BLOCKS}/Chest_Front.png`);

    const side = new Canvas();
    side.rect(0,0,16,16,WM);
    side.rect(0,0,16,2,WL); side.rect(0,14,16,2,WD);
    side.rect(0,7,16,2,IM);
    side.line(4,0,4,15,WD); side.line(12,0,12,15,WD);
    save(side, `${BLOCKS}/Chest_Side.png`);

    const top = new Canvas();
    top.rect(0,0,16,16,WM);
    top.rect(0,0,16,2,WL);
    top.rect(0,6,16,2,IM);
    top.line(4,0,4,15,WD); top.line(12,0,12,15,WD);
    save(top, `${BLOCKS}/Chest_Top.png`);
})();

// Anvil block face
(function() {
    const face = new Canvas();
    // Base rectangle
    face.rect(0,10,16,6,GYD);
    face.rect(0,10,16,2,GY);
    face.rect(0,15,16,1,MB);
    // Neck
    face.rect(3,7,10,3,GYD);
    face.rect(3,7,10,1,GY);
    // Top flat
    face.rect(1,2,14,5,GY);
    face.rect(1,2,14,2,MH);
    face.rect(1,6,14,1,GYD);
    // Horn left
    face.rect(1,3,3,3,GY);
    save(face, `${BLOCKS}/Anvil.png`);
})();

console.log('\nDone!');
