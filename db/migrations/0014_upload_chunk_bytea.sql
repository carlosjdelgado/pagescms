ALTER TABLE "upload_chunk" ALTER COLUMN "data" SET DATA TYPE bytea USING decode("data", 'base64');
