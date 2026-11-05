{
  "targets": [
    {
      "target_name": "peercred",
      "sources": ["src/peercred.c"],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "OTHER_LDFLAGS": ["-undefined", "dynamic_lookup"]
          }
        }]
      ]
    }
  ]
}
