# Beer Gate

Lock any webpage until the visitor skulls a beer live on their webcam.

**Try it and get the code:** https://minimumleather.github.io/beer-gate/

## Add it to your site

Put this in the `<head>` of any page you want locked:

```html
<script src="https://minimumleather.github.io/beer-gate/beer-gate.js"></script>
```

Step-by-step instructions for Wix, Squarespace, WordPress, Shopify, Webflow and AI-built sites are on the [code page](https://minimumleather.github.io/beer-gate/code.html).

### Settings

Add any of these to the script tag:

| Attribute | Default | What it does |
|---|---|---|
| `data-title` | `Skull a beer to enter` | Heading on the gate |
| `data-max-seconds` | `25` | Time to finish; the chant stretches to fit |
| `data-remember` | `true` | Stay unlocked until the browser is closed |
| `data-auto` | `true` | Set to `false` to open it yourself with `BeerGate.open()` |

When someone passes, a `beergate:unlock` event fires on `document` with the skull time in `event.detail.seconds`.

## How it works

Everything runs in the visitor's browser using [MediaPipe](https://ai.google.dev/edge/mediapipe) face, hand and object detection. No video is recorded or uploaded.

1. Two random face checks prove the visitor is live.
2. They hold up their drink.
3. After 3, 2, 1, the chant and drumroll start.
4. They have to get the empty upside down over their head before the count hits 1.

## Fine print

It's a party trick, not real security: anyone handy with browser dev tools can get around it. For adults of legal drinking age. Drink responsibly.
