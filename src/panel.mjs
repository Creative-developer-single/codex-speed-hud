import { gaugeMarkup } from './gauge.mjs'

const icon = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`
const first = icon('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5M9 2h6M12 2v3"/>')
const average = icon('<path d="M4 19h16M7 15v-4M12 15V7M17 15v-6"/>')
const tokens = icon('<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>')
const bolt = icon('<path d="m13.5 3-8 10h6l-1 8 8-11h-6z"/>')
const meter = icon('<path d="M4 18a9 9 0 1 1 16 0M12 13l4-5M6 13H4M20 13h-2M12 4v2"/><circle cx="12" cy="13" r="1.5"/>')
export const toolbarIcon = meter

export function panelMarkup() {
  return `<style>
    :host{font:12px/1.5 system-ui,sans-serif;color:light-dark(#262735,#f3f1fa);--accent:light-dark(#9b75ed,#b498ff);--muted:light-dark(#7c7a90,#aaa6bf);--line:light-dark(#e9e6f1,#3c3849)}
    *{box-sizing:border-box}section{background:light-dark(#fcfcff,#22212a);border:1px solid var(--line);border-radius:24px;box-shadow:0 14px 48px #18102e24;overflow:hidden}
    header{display:flex;align-items:center;gap:6px;padding:12px 14px 4px;cursor:grab;touch-action:none}
    .mode{display:flex;align-items:center;gap:5px;margin-right:auto;color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.04em}.mode svg{width:18px;height:18px}.mode[data-fast-active="true"]{color:var(--accent)}.badge{border-radius:20px;background:light-dark(#efebf7,#363042);padding:3px 8px}.mode[data-fast-active="true"] .badge{background:light-dark(#eee5ff,#40325b)}
    button{font:inherit;color:inherit;border:0;background:transparent;cursor:pointer;border-radius:7px}button:disabled{cursor:default}button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}header button{font-size:17px;color:var(--muted);width:25px;height:25px}button:hover:not(:disabled){background:light-dark(#f0edf6,#35313e)}
    [hidden]{display:none!important}
    main{padding:8px 14px 14px}
    .selection{width:100%;display:flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:14px;padding:9px 12px;margin-bottom:10px}.selection div{min-width:0;text-align:center}.effort{font-size:16px;font-weight:600;color:var(--accent);line-height:1.3}.model{font-size:13px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}
    .meter{position:relative;text-align:center}.dial{display:block;width:100%;height:auto;overflow:visible}.track,.progress{fill:none;stroke-width:5;stroke-linecap:round}.track{stroke:light-dark(#eee9f9,#393044)}.progress{stroke:var(--accent);stroke-dasharray:100;stroke-dashoffset:100;transition:stroke-dashoffset .3s ease}.tick{fill:none;stroke:light-dark(#c5bdd8,#686078);stroke-width:1}.tick.major{stroke:var(--muted);stroke-width:1.6}.dial text{fill:var(--muted);font:10px system-ui,sans-serif;text-anchor:middle;font-variant-numeric:tabular-nums}
    .needle{transform-origin:140px 139px;transform:rotate(-90deg);transition:transform .3s ease}.needle path{stroke:var(--accent);stroke-width:2.5;stroke-linecap:round}.needle circle{fill:var(--accent)}.hub{fill:light-dark(#fcfcff,#22212a)}
    .readout{margin-top:-4px;line-height:1.1}.speed{font-size:36px;font-weight:650;letter-spacing:-1.5px;font-variant-numeric:tabular-nums}.unit{color:var(--muted);font-size:11px;margin-top:4px}.caption{display:flex;align-items:center;justify-content:center;gap:7px;color:var(--muted);font-size:10px;margin:7px 0 16px}.caption:before,.caption:after{content:'';width:22px;height:1px;background:var(--line)}
    .stats{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1fr) minmax(0,1.25fr);margin:0}.stats>div{min-width:0;text-align:center;padding:0 3px}.stats>div+div{border-left:1px solid var(--line)}dt{display:flex;justify-content:center;align-items:center;gap:4px;font-size:10px;color:var(--muted);white-space:nowrap}dt svg{width:12px;height:12px}dd{margin:4px 0 0;font-size:12px;font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}.cumulative dd{font-size:11px;overflow:hidden;text-overflow:ellipsis}
    footer{display:flex;align-items:center;justify-content:center;gap:6px;border-top:1px solid var(--line);padding:8px 12px;color:var(--muted);font-size:10px}.dot{width:6px;height:6px;border-radius:50%;background:#40c99a}.dot[data-connected="false"]{background:#aaa5b5}.source{color:var(--muted);opacity:.8}
    @media(prefers-reduced-motion:reduce){.needle,.progress{transition:none}}
  </style><section aria-label="Codex 速度监控">
    <header><div class="mode" data-mode data-fast-active="unknown">${bolt}<span class="badge" data-fast>待确认</span></div><button aria-label="收起面板" data-collapse>−</button><button aria-label="隐藏速率面板" title="通过右上角工具栏重新打开" data-close>×</button></header>
    <main><div class="selection" data-selection aria-label="上次输出的模型记录"><div><div class="effort" data-effort>—</div><div class="model" data-model>等待输出记录</div></div></div>
      <div class="meter">${gaugeMarkup()}<div class="readout"><div class="speed" data-speed>—</div><div class="unit">tok/s</div></div><div class="caption" data-caption>速率</div></div>
      <dl class="stats"><div><dt>${first}首流</dt><dd data-first>—</dd></div><div><dt>${average}本次平均</dt><dd data-average>—</dd></div><div class="cumulative"><dt>${tokens}累计</dt><dd data-tokens>—/—$</dd></div></dl>
    </main><footer><span class="dot" data-dot data-connected="false"></span><span data-status>等待流式事件</span><span class="source" data-source></span></footer>
  </section>`
}
