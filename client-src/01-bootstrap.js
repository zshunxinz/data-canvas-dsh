
    // ECharts loads through a package-local chunk (client.echarts.js, generated
    // from the UMD build by scripts/build-echarts-chunk.mjs). The host's client
    // require only resolves the module table — plugin npm dependencies are not
    // in it (measured) — but require.async('./client.*.js') is the supported
    // chunk escape hatch. Deferred to first chart card, and failures degrade to
    // the bar sketch rather than crashing the page.
    let echarts = null
    let echartsPromise = null
    let echartsLoadFailed = false
    function loadEcharts () {
      return echarts
    }
    function requestEcharts () {
      if (echarts || echartsLoadFailed) return Promise.resolve(echarts)
      if (!echartsPromise) {
        echartsPromise = require.async('./client.echarts.js').then(lib => {
          echarts = lib
          return lib
        }).catch(error => {
          echartsLoadFailed = true
          try { console.error('[xcharts-canvas] echarts unavailable, falling back to sketch:', error?.message) } catch { /* non-fatal */ }
          return null
        })
      }
      return echartsPromise
    }

    const NS = 'settings.xchartsCanvas'
    const inject = ['slots', 'locale']
    const API = '/api/xcharts-canvas'
