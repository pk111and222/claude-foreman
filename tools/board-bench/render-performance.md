# 看板高分屏渲染验证

用合成的 10 小时对话（24,038 条宿主记录，详情页 106 条车道），不读取真实会话。Apple M4、Chrome 157 无头模式、1440×900 CSS 像素、设备像素比 2、默认共享流。优化前后各运行三次，每次用新浏览器配置。`steady` 指飞入、落地两秒后额外采集的三秒；这里没有另外追加高频事件。

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 飞入时的 p95 帧间隔（三次中位数） | 83 ms | 67 ms |
| 落地后两秒的 p95 帧间隔（三次中位数） | 67 ms | 50 ms |
| 平稳阶段的 p95 帧间隔（三次中位数） | 67 ms | 50 ms |
| 平稳阶段 >50 ms 的帧（三轮合计） | 128 | 29 |

这些是浏览器 `requestAnimationFrame` 的间隔，不是 GPU 逐帧计时；机器、窗口尺寸和冷启动会影响结果。飞入仍有偶发长帧。

```sh
export TMPDIR="$(realpath "${TMPDIR:-/tmp}")/"
root=$(mktemp -d "${TMPDIR}foreman-render.XXXXXX")
node board/build.mjs
node tools/board-bench/long.mjs "$root/scenario" 10 35 3
node tools/board-bench/fly.mjs "$root/scenario" --dpr 2 --runs 3 --steady 3 --profile --breakdown --out
```
