/**
 * Test-only: hapbeat-contracts `fixtures/sample-cue-table.json` and `fixtures/sample-scene-recording.json`
 * (contracts branch tmp as of 522c39e, DEC-095), copied as they are so the Scene tab is checked against the specification's samples.
 * Copy them again when the contracts change.
 */

export const CONTRACT_CUE_TABLE = {
  "schema_version": 1,
  "kit": "sample-scene-kit",
  "clips": {
    "footstep": {
      "intensity": 0.8,
      "loop": false,
      "description": "heavy step",
      "syncMs": 12
    },
    "roar": {
      "intensity": 1,
      "loop": false
    },
    "roar_b": {
      "intensity": 0.9,
      "loop": false
    },
    "grab": {
      "intensity": 0.6,
      "loop": false
    },
    "purr": {
      "intensity": 0.4,
      "loop": false
    },
    "rub_loop": {
      "intensity": 0.5,
      "loop": true
    }
  },
  "sounds": {
    "Footstep_A": {
      "intensity": 0.9,
      "syncMs": 30
    },
    "Footstep_B": {
      "intensity": 0.85
    },
    "Roar_A": {
      "intensity": 1
    },
    "Roar_B": {
      "intensity": 0.8
    },
    "Rub": {
      "intensity": 0.5
    }
  },
  "cues": {
    "footstep": {
      "description": "the dinosaur's step",
      "sfx": {
        "sounds": [
          "Footstep_A",
          "Footstep_B"
        ],
        "volume": 1
      },
      "haptics": [
        {
          "clip": "footstep",
          "at": "both",
          "gain": 1
        }
      ],
      "variation": {
        "gainJitterDb": 2,
        "pitchJitterSt": 1,
        "pick": "random"
      },
      "distanceFalloff": {
        "nearCm": 560,
        "farCm": 2000,
        "farGain": 0.15,
        "curve": "easeOut"
      },
      "variants": {
        "approach": {
          "description": "walking in",
          "sfxVolume": 0.6,
          "hapticsGain": 0.5,
          "rampTo": 1,
          "rampCurve": "easeIn"
        },
        "leave": {
          "rampSteps": [
            1,
            0.8,
            0.6,
            0.4
          ]
        }
      },
      "review": {
        "sfx": "approved",
        "haptics": "tentative"
      }
    },
    "roar": {
      "sfx": {
        "sounds": [
          "Roar_A",
          "Roar_B"
        ],
        "volume": 1.2
      },
      "haptics": [
        {
          "clips": [
            "roar",
            "roar_b"
          ],
          "at": "pos_neck",
          "gain": 1
        }
      ],
      "variation": {
        "paired": true
      }
    },
    "grab": {
      "sfx": null,
      "haptics": [
        {
          "clip": "grab",
          "at": "hand",
          "gain": 0.8,
          "alternates": [
            "purr"
          ]
        }
      ]
    },
    "rub": {
      "loop": true,
      "sfx": {
        "sound": "Rub",
        "volume": 1,
        "levelMap": {
          "points": [
            [
              0.5,
              0.4
            ],
            [
              1.5,
              1
            ]
          ],
          "curve": "easeInOut"
        }
      },
      "haptics": [
        {
          "clip": "rub_loop",
          "at": "hand",
          "gain": 1,
          "levelMap": {
            "points": [
              [
                1,
                1
              ]
            ],
            "intercept": 0.1
          }
        }
      ]
    },
    "purr": {
      "haptics": [
        {
          "at": "pos_neck",
          "gain": 1,
          "alternates": [
            "purr"
          ]
        }
      ],
      "emit": {
        "during": "rub",
        "intervalSec": 1.5,
        "jitterPct": 30
      }
    },
    "bite": {
      "description": "not decided yet"
    }
  }
}

export const CONTRACT_SCENE_RECORDING = {
  "session": {
    "schema_version": 1,
    "project": "sample-scene",
    "fps": 30,
    "frames": "Saved/HapticRecord/frames",
    "events": [
      {
        "frame": 30,
        "cue": "footstep:approach",
        "dist": 1800
      },
      {
        "frame": 75,
        "cue": "footstep:approach",
        "dist": 1200
      },
      {
        "frame": 120,
        "cue": "roar",
        "dist": 900
      },
      {
        "frame": 180,
        "cue": "grab",
        "hand": "right",
        "gain": 0.9,
        "note": "right hand on the bone"
      },
      {
        "frame": 200,
        "cue": "purr"
      }
    ],
    "levels": {
      "columns": [
        "rub:level:left",
        "rub:level:right"
      ],
      "rows": [
        [
          0,
          0
        ],
        [
          0,
          0.4
        ],
        [
          0,
          0.9
        ],
        [
          0,
          1.2
        ]
      ]
    },
    "lib": {
      "schema_version": 1,
      "title": "Sample scene",
      "project_name": "sample-scene",
      "paths": {
        "cues": "Content/Hapbeat/sample-cues.json",
        "clips": "Content/Hapbeat/stream-clips",
        "sounds": "Content/Hapbeat/sounds"
      },
      "families": [
        {
          "label": "Dinosaur",
          "color": "#ff8a3d",
          "cues": [
            "footstep",
            "roar"
          ]
        }
      ],
      "ticks": [
        "footstep"
      ],
      "moment_rules": {
        "max": {
          "footstep": 3
        },
        "min_gap_s": {
          "footstep": 2
        },
        "default_max": null
      },
      "import_command": "hapbeat import"
    }
  },
  "viewer_lib_minimal": {
    "schema_version": 1,
    "title": "Minimal",
    "project_name": "minimal",
    "paths": {
      "cues": "Assets/Haptics/cues.json",
      "clips": "Assets/Haptics/clips",
      "sounds": "Assets/Haptics/sounds"
    }
  },
  "viewer_lib_layers": {
    "schema_version": 1,
    "title": "Explicit layers",
    "project_name": "explicit-layers",
    "paths": {
      "cues": "cues.json",
      "clips": "clips",
      "sounds": "sounds"
    },
    "at": [
      "hand",
      "pos_neck"
    ],
    "loop_at": [
      "hand"
    ],
    "layers": [
      {
        "cue": "feed_loop",
        "level": [
          0,
          1
        ],
        "rate": [
          2,
          3
        ],
        "colors": [
          "#4ea1ff",
          "#ff8a3d"
        ]
      },
      {
        "cue": "cut_loop",
        "level": [
          4,
          4
        ],
        "rate": null,
        "colors": [
          "#aaaaaa"
        ]
      }
    ]
  },
  "viewer_data": {
    "schema_version": 1,
    "fps": 30,
    "frames": 240,
    "video": "full_replay.mp4",
    "events": [
      {
        "t": 1.0,
        "name": "footstep:approach",
        "dist": 1800
      },
      {
        "t": 4.0,
        "name": "roar",
        "dist": 900
      },
      {
        "t": 6.0,
        "name": "grab",
        "hand": "right",
        "gain": 0.9,
        "note": "right hand on the bone"
      }
    ],
    "levels": {
      "columns": [
        "rub:level:left",
        "rub:level:right"
      ],
      "rows": [
        [
          0,
          0
        ],
        [
          0,
          0.4
        ]
      ]
    }
  }
}
