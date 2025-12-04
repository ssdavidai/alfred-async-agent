-- CreateTable
CREATE TABLE "connections" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "template_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger_type" TEXT NOT NULL,
    "trigger_config" JSONB,
    "steps" JSONB NOT NULL,
    "connection_names" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "executions" (
    "id" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "input" JSONB,
    "output" TEXT,
    "trace" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "token_count" INTEGER,
    "cost_usd" DECIMAL(10,6),
    "reported_to_core" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_pkey" PRIMARY KEY ("key")
);

-- CreateTable (junction table for many-to-many relationship)
CREATE TABLE "_SkillConnections" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "connections_name_key" ON "connections"("name");

-- CreateIndex
CREATE INDEX "connections_type_idx" ON "connections"("type");

-- CreateIndex
CREATE INDEX "connections_is_active_idx" ON "connections"("is_active");

-- CreateIndex
CREATE INDEX "skills_trigger_type_idx" ON "skills"("trigger_type");

-- CreateIndex
CREATE INDEX "skills_is_active_idx" ON "skills"("is_active");

-- CreateIndex
CREATE INDEX "skills_is_system_idx" ON "skills"("is_system");

-- CreateIndex
CREATE INDEX "executions_skill_id_started_at_idx" ON "executions"("skill_id", "started_at");

-- CreateIndex
CREATE INDEX "executions_status_idx" ON "executions"("status");

-- CreateIndex
CREATE INDEX "executions_trigger_idx" ON "executions"("trigger");

-- CreateIndex
CREATE INDEX "executions_reported_to_core_idx" ON "executions"("reported_to_core");

-- CreateIndex
CREATE UNIQUE INDEX "_SkillConnections_AB_unique" ON "_SkillConnections"("A", "B");

-- CreateIndex
CREATE INDEX "_SkillConnections_B_index" ON "_SkillConnections"("B");

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SkillConnections" ADD CONSTRAINT "_SkillConnections_A_fkey" FOREIGN KEY ("A") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SkillConnections" ADD CONSTRAINT "_SkillConnections_B_fkey" FOREIGN KEY ("B") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
