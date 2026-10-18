---
kind: mdbase.type
name: person
version: 1
description: An author or other person.
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required:
      - name
    additionalProperties: true
    properties:
      type:
        const: person
      name:
        type: string
        minLength: 1
      born:
        type: string
        format: date
match:
  path_glob: People/**/*.md
collection:
  display:
    name_field: name
---

# Person
