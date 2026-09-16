// Bundled review-only schemas. Parity with the distributed pack is tested.
export const accountsReviewSchemas = {
  "accounts-anz-reference-candidates": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://realbud.invalid/contracts/accounts-anz-reference-candidates.schema.json",
    "title": "accounts-anz-reference-candidates",
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "version": {
        "const": 1
      },
      "kind": {
        "const": "accounts-anz-reference-candidates"
      },
      "sourceReference": {
        "type": "string"
      },
      "status": {
        "enum": [
          "complete",
          "partial",
          "blocked"
        ]
      },
      "coverageComplete": {
        "type": "boolean"
      },
      "originalDigest": {
        "type": [
          "string",
          "null"
        ]
      },
      "rows": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sourceRow": {
              "type": "integer",
              "minimum": 1
            },
            "rowId": {
              "type": "string"
            },
            "decision": {
              "enum": [
                "assign",
                "keep",
                "hold"
              ]
            },
            "propertyId": {
              "type": [
                "string",
                "null"
              ]
            },
            "proposedReference": {
              "type": [
                "string",
                "null"
              ]
            },
            "reason": {
              "type": "string"
            }
          },
          "required": [
            "sourceRow",
            "rowId",
            "decision",
            "propertyId",
            "proposedReference",
            "reason"
          ]
        }
      },
      "hostValidation": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "required": {
            "const": true
          },
          "batchId": {
            "type": [
              "string",
              "null"
            ]
          },
          "batchRevision": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 1
          },
          "originalDigest": {
            "type": [
              "string",
              "null"
            ]
          },
          "applied": {
            "const": false
          }
        },
        "required": [
          "required",
          "batchId",
          "batchRevision",
          "originalDigest",
          "applied"
        ]
      },
      "holds": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "itemId": {
              "type": "string"
            },
            "reason": {
              "type": "string"
            }
          },
          "required": [
            "itemId",
            "reason"
          ]
        }
      },
      "actionsPerformed": {
        "type": "array",
        "maxItems": 0
      }
    },
    "required": [
      "version",
      "kind",
      "sourceReference",
      "status",
      "coverageComplete",
      "originalDigest",
      "rows",
      "hostValidation",
      "holds",
      "actionsPerformed"
    ]
  },
  "accounts-bill-exception-review": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://realbud.invalid/contracts/accounts-bill-exception-review.schema.json",
    "title": "accounts-bill-exception-review",
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "version": {
        "const": 1
      },
      "kind": {
        "const": "accounts-bill-exception-review"
      },
      "sourceReference": {
        "type": "string"
      },
      "status": {
        "enum": [
          "complete",
          "partial",
          "blocked"
        ]
      },
      "coverageComplete": {
        "type": "boolean"
      },
      "findings": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "occurrenceId": {
              "type": "string"
            },
            "propertyId": {
              "type": "string"
            },
            "arrival": {
              "enum": [
                "received",
                "missing",
                "not-due",
                "unknown"
              ]
            },
            "dueDate": {
              "type": [
                "string",
                "null"
              ]
            },
            "payment": {
              "enum": [
                "confirmed",
                "arranged-unconfirmed",
                "unknown"
              ]
            },
            "funding": {
              "enum": [
                "sufficient",
                "insufficient",
                "unknown"
              ]
            },
            "advance": {
              "enum": [
                "none",
                "outstanding",
                "recovered",
                "unknown"
              ]
            },
            "flags": {
              "type": "array",
              "items": {
                "enum": [
                  "due-without-confirmed-payment",
                  "insufficient-funds",
                  "advance-unrecovered",
                  "owner-to-pay",
                  "conflicting-invoice",
                  "missing-arrival",
                  "coverage-gap",
                  "missing-due-date"
                ]
              }
            },
            "sourceIds": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "reason": {
              "type": "string"
            }
          },
          "required": [
            "occurrenceId",
            "propertyId",
            "arrival",
            "dueDate",
            "payment",
            "funding",
            "advance",
            "flags",
            "sourceIds",
            "reason"
          ]
        }
      },
      "holds": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "itemId": {
              "type": "string"
            },
            "reason": {
              "type": "string"
            }
          },
          "required": [
            "itemId",
            "reason"
          ]
        }
      },
      "actionsPerformed": {
        "type": "array",
        "maxItems": 0
      }
    },
    "required": [
      "version",
      "kind",
      "sourceReference",
      "status",
      "coverageComplete",
      "findings",
      "holds",
      "actionsPerformed"
    ]
  },
  "accounts-inbox-triage": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://realbud.invalid/contracts/accounts-inbox-triage.schema.json",
    "title": "accounts-inbox-triage",
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "version": {
        "const": 1
      },
      "kind": {
        "const": "accounts-inbox-triage"
      },
      "sourceReference": {
        "type": "string"
      },
      "status": {
        "enum": [
          "complete",
          "partial",
          "blocked"
        ]
      },
      "coverageComplete": {
        "type": "boolean"
      },
      "skillSource": {
        "enum": [
          "email-inbox-triage@0.1.0"
        ]
      },
      "threads": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "threadId": {
              "type": "string"
            },
            "disposition": {
              "enum": [
                "urgent-review",
                "reply-review",
                "action-review",
                "waiting",
                "reference",
                "noise",
                "hold"
              ]
            },
            "owner": {
              "enum": [
                "accounts-reviewer",
                "property-manager",
                "source-owner",
                "unassigned"
              ]
            },
            "priority": {
              "enum": [
                "high",
                "normal",
                "low"
              ]
            },
            "sourceMessageIds": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "reason": {
              "type": "string"
            },
            "nextAction": {
              "type": "string"
            },
            "missingFacts": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "required": [
            "threadId",
            "disposition",
            "owner",
            "priority",
            "sourceMessageIds",
            "reason",
            "nextAction",
            "missingFacts"
          ]
        }
      },
      "holds": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "itemId": {
              "type": "string"
            },
            "reason": {
              "type": "string"
            }
          },
          "required": [
            "itemId",
            "reason"
          ]
        }
      },
      "actionsPerformed": {
        "type": "array",
        "maxItems": 0
      }
    },
    "required": [
      "version",
      "kind",
      "sourceReference",
      "status",
      "coverageComplete",
      "skillSource",
      "threads",
      "holds",
      "actionsPerformed"
    ]
  },
  "accounts-invoice-entry-review": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://realbud.invalid/contracts/accounts-invoice-entry-review.schema.json",
    "title": "accounts-invoice-entry-review",
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "version": {
        "const": 1
      },
      "kind": {
        "const": "accounts-invoice-entry-review"
      },
      "sourceReference": {
        "type": "string"
      },
      "status": {
        "enum": [
          "complete",
          "partial",
          "blocked"
        ]
      },
      "coverageComplete": {
        "type": "boolean"
      },
      "documents": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "documentId": {
              "type": "string"
            },
            "decision": {
              "enum": [
                "queue",
                "duplicate",
                "hold"
              ]
            },
            "duplicateOf": {
              "type": [
                "string",
                "null"
              ]
            },
            "conflictGroup": {
              "type": [
                "string",
                "null"
              ]
            },
            "proposedEntry": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "supplierId": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "invoiceId": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "propertyId": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "amount": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "currency": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "dueDate": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "costType": {
                  "type": [
                    "string",
                    "null"
                  ]
                }
              },
              "required": [
                "supplierId",
                "invoiceId",
                "propertyId",
                "amount",
                "currency",
                "dueDate",
                "costType"
              ]
            },
            "sourceIds": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "reason": {
              "type": "string"
            }
          },
          "required": [
            "documentId",
            "decision",
            "duplicateOf",
            "conflictGroup",
            "proposedEntry",
            "sourceIds",
            "reason"
          ]
        }
      },
      "holds": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "itemId": {
              "type": "string"
            },
            "reason": {
              "type": "string"
            }
          },
          "required": [
            "itemId",
            "reason"
          ]
        }
      },
      "actionsPerformed": {
        "type": "array",
        "maxItems": 0
      }
    },
    "required": [
      "version",
      "kind",
      "sourceReference",
      "status",
      "coverageComplete",
      "documents",
      "holds",
      "actionsPerformed"
    ]
  }
} as const;
