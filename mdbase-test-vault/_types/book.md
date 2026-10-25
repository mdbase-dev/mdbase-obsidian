---
kind: mdbase.type
name: book
version: 1
description: A book in the library.
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required:
      - title
    additionalProperties: true
    properties:
      type:
        const: book
      title:
        type: string
        minLength: 1
      author:
        type: string
      published:
        type: boolean
      year:
        type: integer
        minimum: 1000
        maximum: 2100
      status:
        enum:
          - to-read
          - reading
          - finished
      rating:
        type: integer
        minimum: 1
        maximum: 5
      tags:
        type: array
        items:
          type: string
match:
  path_glob: Library/**/*.md
collection:
  display:
    name_field: title
  read_defaults:
    status: to-read
  links:
    author:
      target_type: person
      validate_exists: true
---

# Book

One note per book under `Library/`. `author` links to a person.
