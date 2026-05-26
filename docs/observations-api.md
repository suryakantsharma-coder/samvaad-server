# Observations API

Base path: `/api/observations`

## Data model

Observation document shape:

```json
{
  "_id": "mongodb_object_id",
  "patientId": "mongodb_object_id",
  "hospital": "mongodb_object_id",
  "observations": [
    {
      "_id": "mongodb_object_id",
      "text": "Patient reports mild fever",
      "time": "2026-05-26T11:30:00.000Z"
    }
  ],
  "createdAt": "2026-05-26T11:35:00.000Z",
  "updatedAt": "2026-05-26T11:35:00.000Z"
}
```

## 1) Create observation document

`POST /api/observations`

```bash
curl --location 'http://localhost:3000/api/observations' \
--header 'Authorization: Bearer YOUR_TOKEN' \
--header 'Content-Type: application/json' \
--data '{
  "patientId": "68340b95b2f9f4e8ad7a1111",
  "observations": [
    {
      "text": "Patient has headache since morning",
      "time": "2026-05-26T10:00:00.000Z"
    }
  ]
}'
```

## 2) Edit observation document (replace full observations array)

`PATCH /api/observations/:id`

```bash
curl --location --request PATCH 'http://localhost:3000/api/observations/68340be7b2f9f4e8ad7a2222' \
--header 'Authorization: Bearer YOUR_TOKEN' \
--header 'Content-Type: application/json' \
--data '{
  "observations": [
    {
      "text": "Headache improved after medicine",
      "time": "2026-05-26T12:30:00.000Z"
    },
    {
      "text": "No nausea reported",
      "time": "2026-05-26T12:45:00.000Z"
    }
  ]
}'
```

## 3) Add single observation entry to array

`POST /api/observations/:id/entries`

```bash
curl --location 'http://localhost:3000/api/observations/68340be7b2f9f4e8ad7a2222/entries' \
--header 'Authorization: Bearer YOUR_TOKEN' \
--header 'Content-Type: application/json' \
--data '{
  "text": "Patient temperature is now normal",
  "time": "2026-05-26T13:00:00.000Z"
}'
```

## 4) Search by patientId

`GET /api/observations/search?patientId=<PATIENT_ID>`

```bash
curl --location 'http://localhost:3000/api/observations/search?patientId=68340b95b2f9f4e8ad7a1111' \
--header 'Authorization: Bearer YOUR_TOKEN'
```

## 5) Delete observation document

`DELETE /api/observations/:id`

```bash
curl --location --request DELETE 'http://localhost:3000/api/observations/68340be7b2f9f4e8ad7a2222' \
--header 'Authorization: Bearer YOUR_TOKEN'
```
