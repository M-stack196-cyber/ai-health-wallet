import type { QueryResultRow } from "pg";
import type { PatientDatabase } from "../patients/repository.js";
import type { DocumentFilters, DocumentMetadata, FileType, MetadataPatch } from "./validation.js";
export interface DocumentRow extends QueryResultRow {
  id: string; original_filename: string; file_type: FileType; category: string;
  hospital_name: string | null; document_date: string | null; uploaded_at: Date;
  processing_status: string; sort_date: string; sort_date_source: "document_date" | "uploaded_at";
}
export interface DocumentReference extends DocumentRow { s3_bucket: string; s3_object_key: string; }
export interface NewDocument extends DocumentMetadata {
  id: string; patientId: string; bucket: string; key: string; name: string; type: FileType;
}
const projection = `id, original_filename, file_type, category, hospital_name, document_date::text AS document_date,
  uploaded_at, processing_status, COALESCE(document_date, (uploaded_at AT TIME ZONE 'UTC')::date)::text AS sort_date,
  CASE WHEN document_date IS NULL THEN 'uploaded_at' ELSE 'document_date' END AS sort_date_source`;
export function createDocumentRepository(database: PatientDatabase) {
  return {
    async insert(input: NewDocument): Promise<DocumentRow> {
      const result = await database.query<DocumentRow>(`INSERT INTO public.medical_documents
        (id, patient_id, s3_bucket, s3_object_key, original_filename, file_type, category, hospital_name, document_date, processing_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'processing') RETURNING ${projection}`,
      [input.id, input.patientId, input.bucket, input.key, input.name, input.type, input.category, input.hospital_name, input.document_date ?? null]);
      if (!result.rows[0]) throw new Error("Document insert result unavailable.");
      return result.rows[0];
    },
    async reference(id: string, patientId: string): Promise<DocumentReference | undefined> {
      return (await database.query<DocumentReference>(`SELECT ${projection}, s3_bucket, s3_object_key
        FROM public.medical_documents WHERE id = $1 AND patient_id = $2`, [id, patientId])).rows[0];
    },
    async list(patientId: string, options: DocumentFilters): Promise<{ documents: DocumentRow[]; hasMore: boolean }> {
      const values: unknown[] = [patientId];
      const conditions = ["patient_id = $1"];
      const add = (value: unknown, expression: (position: number) => string) => { values.push(value); conditions.push(expression(values.length)); };
      if (options.category) add(options.category, n => "category = $" + n);
      if (options.hospital) add(options.hospital, n => "lower(hospital_name) = lower($" + n + ")");
      if (options.uploadedFrom) add(options.uploadedFrom, n => "uploaded_at >= ($" + n + "::date::timestamp AT TIME ZONE 'UTC')");
      if (options.uploadedTo) add(options.uploadedTo, n => "uploaded_at < (($" + n + "::date + 1)::timestamp AT TIME ZONE 'UTC')");
      values.push(options.limit + 1, options.offset);
      const result = await database.query<DocumentRow>(`SELECT ${projection} FROM public.medical_documents
        WHERE ${conditions.join(" AND ")} ORDER BY COALESCE(document_date, (uploaded_at AT TIME ZONE 'UTC')::date) DESC, uploaded_at DESC, id ASC
        LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
      return { documents: result.rows.slice(0, options.limit), hasMore: result.rows.length > options.limit };
    },
    async update(id: string, patientId: string, changes: MetadataPatch): Promise<DocumentRow | undefined> {
      const keys = (["category", "hospital_name", "document_date"] as const).filter(key => Object.hasOwn(changes, key));
      const result = await database.query<DocumentRow>(`UPDATE public.medical_documents
        SET ${keys.map((key, index) => key + " = $" + (index + 3)).join(", ")}
        WHERE id = $1 AND patient_id = $2 RETURNING ${projection}`, [id, patientId, ...keys.map(key => changes[key])]);
      return result.rows[0];
    },
  };
}
export function publicDocument(row: DocumentRow): DocumentRow {
  // Explicit allowlist also strips private references from internal read-back rows.
  const { id, original_filename, file_type, category, hospital_name, document_date, uploaded_at, processing_status, sort_date, sort_date_source } = row;
  return { id, original_filename, file_type, category, hospital_name, document_date, uploaded_at, processing_status, sort_date, sort_date_source };
}
