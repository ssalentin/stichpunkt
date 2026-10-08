---
tags: [diagrams]
---
# Vega-Lite

```vega-lite
{
  "data": {"values": [
    {"month": "Jan", "pages": 12}, {"month": "Feb", "pages": 19},
    {"month": "Mar", "pages": 31}, {"month": "Apr", "pages": 44}
  ]},
  "mark": {"type": "bar", "color": "#5cc8a8"},
  "encoding": {
    "x": {"field": "month", "type": "ordinal", "sort": null},
    "y": {"field": "pages", "type": "quantitative"}
  }
}
```
