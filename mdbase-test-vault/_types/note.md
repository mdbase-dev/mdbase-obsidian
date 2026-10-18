---
kind: mdbase.type
name: note
version: 1
description: A free-form note with tags.
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required:
      - title
    additionalProperties: true
    properties:
      type:
        const: note
      title:
        type: string
        minLength: 1
      tags:
        type: array
        items:
          type: string
---

# Note

Notes need a `type: note` key; they have no folder of their own.
