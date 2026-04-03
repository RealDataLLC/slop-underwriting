-- Slop Underwriting — Supabase Schema
-- Applied to Soupleaf project (loqriakpdmmcstnnkqtb)
-- Based on CRE Auto Underwriting Spec v0.5
--
-- Entity hierarchy:
--   uw_projects → uw_properties → uw_deals → uw_documents
--                                           → uw_versions
--   uw_comps (shared, not scoped to project)

-- ── PREREQUISITES ─────────────────────────────────────────────────────────────

CREATE TABLE public.profiles (
    id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email       text,
    role        text NOT NULL DEFAULT 'broker'
                CHECK (role IN ('admin', 'broker', 'analyst', 'viewer')),
    domain      text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select" ON public.profiles
    FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "profiles_update_own" ON public.profiles
    FOR UPDATE USING (id = auth.uid());

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now() AT TIME ZONE 'America/Chicago';
    RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ── 1. PROJECTS ───────────────────────────────────────────────────────────────
-- One row per acquisition opportunity. May contain one or many properties.

CREATE TABLE public.uw_projects (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at              timestamptz NOT NULL DEFAULT (now() AT TIME ZONE 'America/Chicago'),
    updated_at              timestamptz NOT NULL DEFAULT (now() AT TIME ZONE 'America/Chicago'),
    created_by              uuid REFERENCES public.profiles(id),

    name                    text NOT NULL,
    description             text,
    status                  text NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'under_contract', 'closed', 'dead')),

    target_cap_rate         numeric,
    max_cap_rate            numeric,
    target_irr              numeric,
    notes                   text
);

COMMENT ON TABLE public.uw_projects IS
    'An acquisition opportunity. Contains one or more properties. '
    'Provides target return parameters that cascade to deal underwriting.';

ALTER TABLE public.uw_projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "uw_projects_select" ON public.uw_projects
    FOR SELECT USING (
        created_by = auth.uid()
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'admin'
        )
    );
CREATE POLICY "uw_projects_insert" ON public.uw_projects
    FOR INSERT WITH CHECK (created_by = auth.uid());
CREATE POLICY "uw_projects_update" ON public.uw_projects
    FOR UPDATE USING (
        created_by = auth.uid()
        OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
    );

CREATE TRIGGER uw_projects_updated_at
    BEFORE UPDATE ON public.uw_projects
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ── 2. PROPERTIES ─────────────────────────────────────────────────────────────
-- One row per physical address within a project.

CREATE TABLE public.uw_properties (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id              uuid NOT NULL REFERENCES public.uw_projects(id) ON DELETE CASCADE,
    created_at              timestamptz NOT NULL DEFAULT (now() AT TIME ZONE 'America/Chicago'),
    updated_at              timestamptz NOT NULL DEFAULT (now() AT TIME ZONE 'America/Chicago'),
    created_by              uuid REFERENCES public.profiles(id),

    name                    text NOT NULL,
    property_address        text,
    city                    text,
    state                   char(2),
    zip                     text,
    market                  text,
    property_type           text
                            CHECK (property_type IN (
                                'QSR', 'Pharmacy', 'Dollar', 'Auto',
                                'C-Store', 'Bank', 'Medical', 'Other'
                            )),

    costar_property_id      bigint,

    -- Denormalized from latest uw_deals row for fast dashboard queries
    latest_deal_id          uuid,
    latest_recommendation   text CHECK (latest_recommendation IN ('go', 'watch', 'pass')),
    latest_risk_score       smallint,
    latest_underwritten_at  timestamptz,

    notes                   text,
    is_archived             boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE public.uw_properties IS
    'One physical address within an acquisition project. '
    'latest_* columns are denormalized from the most recent uw_deals row.';

ALTER TABLE public.uw_properties ENABLE ROW LEVEL SECURITY;

CREATE POLICY "uw_properties_select" ON public.uw_properties
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.uw_projects p
            WHERE p.id = project_id
              AND (
                  p.created_by = auth.uid()
                  OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
              )
        )
    );
CREATE POLICY "uw_properties_insert" ON public.uw_properties
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.uw_projects p
            WHERE p.id = project_id AND p.created_by = auth.uid()
        )
    );
CREATE POLICY "uw_properties_update" ON public.uw_properties
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.uw_projects p
            WHERE p.id = project_id
              AND (
                  p.created_by = auth.uid()
                  OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
              )
        )
    );

CREATE TRIGGER uw_properties_updated_at
    BEFORE UPDATE ON public.uw_properties
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ── 3. DEALS ──────────────────────────────────────────────────────────────────
-- One row per underwriting run on a property. Append-only history.

CREATE TABLE public.uw_deals (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id             uuid NOT NULL REFERENCES public.uw_properties(id) ON DELETE CASCADE,
    created_at              timestamptz NOT NULL DEFAULT (now() AT TIME ZONE 'America/Chicago'),
    updated_at              timestamptz NOT NULL DEFAULT (now() AT TIME ZONE 'America/Chicago'),
    created_by              uuid REFERENCES public.profiles(id),

    label                   text,

    status                  text NOT NULL DEFAULT 'uploading'
                            CHECK (status IN (
                                'uploading',
                                'extracting',
                                'review',
                                'underwriting',
                                'complete',
                                'archived'
                            )),

    human_review_required   boolean NOT NULL DEFAULT false,
    review_cleared_by       uuid REFERENCES public.profiles(id),
    review_cleared_at       timestamptz,
    review_summary          text,

    deal_schema             jsonb,
    underwriting_output     jsonb,
    assumption_overrides    jsonb,

    memo_pdf_key            text,
    proforma_excel_key      text,

    recommendation          text CHECK (recommendation IN ('go', 'watch', 'pass')),
    recommendation_rationale text,
    risk_score              smallint CHECK (risk_score BETWEEN 0 AND 100)
);

COMMENT ON TABLE public.uw_deals IS
    'One underwriting run per property upload or revisit. '
    'History is append-only. Storage scoped to {property_id}/{deal_id}/.';

ALTER TABLE public.uw_deals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "uw_deals_select" ON public.uw_deals
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.uw_properties pr
            JOIN public.uw_projects pj ON pj.id = pr.project_id
            WHERE pr.id = property_id
              AND (
                  pj.created_by = auth.uid()
                  OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
              )
        )
    );
CREATE POLICY "uw_deals_insert" ON public.uw_deals
    FOR INSERT WITH CHECK (created_by = auth.uid());
CREATE POLICY "uw_deals_update" ON public.uw_deals
    FOR UPDATE USING (
        created_by = auth.uid()
        OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
    );

CREATE TRIGGER uw_deals_updated_at
    BEFORE UPDATE ON public.uw_deals
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Sync latest_* fields on uw_properties when a deal completes
CREATE OR REPLACE FUNCTION public.uw_sync_property_latest()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'complete' AND NEW.recommendation IS NOT NULL THEN
        UPDATE public.uw_properties SET
            latest_deal_id          = NEW.id,
            latest_recommendation   = NEW.recommendation,
            latest_risk_score       = NEW.risk_score,
            latest_underwritten_at  = NEW.updated_at,
            updated_at              = now() AT TIME ZONE 'America/Chicago'
        WHERE id = NEW.property_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER uw_deals_sync_property
    AFTER INSERT OR UPDATE ON public.uw_deals
    FOR EACH ROW EXECUTE FUNCTION public.uw_sync_property_latest();


-- ── 4. DOCUMENTS ──────────────────────────────────────────────────────────────
-- One row per uploaded file. Belongs to a deal.

CREATE TABLE public.uw_documents (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id                 uuid NOT NULL REFERENCES public.uw_deals(id) ON DELETE CASCADE,
    created_at              timestamptz NOT NULL DEFAULT (now() AT TIME ZONE 'America/Chicago'),

    document_type           text NOT NULL
                            CHECK (document_type IN (
                                'om', 'rent_roll', 'financial_statement', 'lease', 'other'
                            )),

    original_filename       text NOT NULL,
    storage_key             text NOT NULL,
    file_size_bytes         bigint,
    mime_type               text,

    extraction_status       text NOT NULL DEFAULT 'pending'
                            CHECK (extraction_status IN ('pending', 'running', 'complete', 'failed')),
    extracted_at            timestamptz,
    extraction_confidence   jsonb,
    page_classification     jsonb,
    raw_extraction          jsonb,
    extraction_error        text
);

ALTER TABLE public.uw_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "uw_documents_all" ON public.uw_documents
    USING (
        EXISTS (
            SELECT 1 FROM public.uw_deals d
            JOIN public.uw_properties pr ON pr.id = d.property_id
            JOIN public.uw_projects pj ON pj.id = pr.project_id
            WHERE d.id = deal_id
              AND (
                  pj.created_by = auth.uid()
                  OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
              )
        )
    );


-- ── 5. VERSIONS ───────────────────────────────────────────────────────────────
-- Full audit trail of every engine run or assumption override per deal.

CREATE TABLE public.uw_versions (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id                 uuid NOT NULL REFERENCES public.uw_deals(id) ON DELETE CASCADE,
    created_at              timestamptz NOT NULL DEFAULT (now() AT TIME ZONE 'America/Chicago'),
    created_by              uuid REFERENCES public.profiles(id),

    version_number          smallint NOT NULL,
    trigger                 text NOT NULL
                            CHECK (trigger IN ('initial', 'assumption_override', 'reextraction')),

    assumptions             jsonb NOT NULL,
    rent_schedule           jsonb NOT NULL,
    cash_flow_model         jsonb NOT NULL,
    exit_analysis           jsonb NOT NULL,
    sensitivity_grid        jsonb NOT NULL,
    pricing_output          jsonb NOT NULL,
    risk_score              smallint,
    risk_flags              jsonb,
    recommendation          text CHECK (recommendation IN ('go', 'watch', 'pass'))
);

ALTER TABLE public.uw_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "uw_versions_select" ON public.uw_versions
    USING (
        EXISTS (
            SELECT 1 FROM public.uw_deals d
            JOIN public.uw_properties pr ON pr.id = d.property_id
            JOIN public.uw_projects pj ON pj.id = pr.project_id
            WHERE d.id = deal_id
              AND (
                  pj.created_by = auth.uid()
                  OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
              )
        )
    );

-- Auto-increment version_number per deal
CREATE OR REPLACE FUNCTION public.uw_versions_set_version_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.version_number := COALESCE(
        (SELECT MAX(version_number) FROM public.uw_versions WHERE deal_id = NEW.deal_id), 0
    ) + 1;
    RETURN NEW;
END;
$$;

CREATE TRIGGER uw_versions_version_number
    BEFORE INSERT ON public.uw_versions
    FOR EACH ROW EXECUTE FUNCTION public.uw_versions_set_version_number();


-- ── 6. COMPS ──────────────────────────────────────────────────────────────────
-- Shared sale comp database. Not scoped to a project.

CREATE TABLE public.uw_comps (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at              timestamptz NOT NULL DEFAULT (now() AT TIME ZONE 'America/Chicago'),
    updated_at              timestamptz NOT NULL DEFAULT (now() AT TIME ZONE 'America/Chicago'),
    created_by              uuid REFERENCES public.profiles(id),
    source_deal_id          uuid REFERENCES public.uw_deals(id) ON DELETE SET NULL,

    property_type           text NOT NULL
                            CHECK (property_type IN (
                                'QSR', 'Pharmacy', 'Dollar', 'Auto',
                                'C-Store', 'Bank', 'Medical', 'Other'
                            )),
    property_address        text,
    city                    text,
    state                   char(2),
    market                  text,
    gla_sf                  numeric,
    year_built              smallint,
    has_drive_thru          boolean,

    tenant_name             text NOT NULL,
    parent_company          text,
    credit_tier             text NOT NULL
                            CHECK (credit_tier IN (
                                'investment_grade', 'national_credit', 'franchisee', 'local'
                            )),
    is_corporate_guarantee  boolean,

    lease_type              text CHECK (lease_type IN ('NNN', 'NN', 'Gross', 'Modified-Gross')),
    remaining_term_years    numeric,
    options_count           smallint,

    close_date              date NOT NULL,
    sale_price              numeric NOT NULL,
    noi                     numeric NOT NULL,
    cap_rate                numeric NOT NULL
                            GENERATED ALWAYS AS (noi / NULLIF(sale_price, 0)) STORED,
    price_per_sf            numeric,

    source                  text NOT NULL
                            CHECK (source IN ('internal', 'rca', 'costar', 'manual')),
    source_id               text,
    notes                   text
);

COMMENT ON TABLE public.uw_comps IS
    'Sale comp database for cap rate benchmarking. '
    'cap_rate is a generated column (noi / sale_price).';

ALTER TABLE public.uw_comps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "uw_comps_select" ON public.uw_comps
    FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "uw_comps_insert" ON public.uw_comps
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "uw_comps_update" ON public.uw_comps
    FOR UPDATE USING (
        created_by = auth.uid()
        OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
    );

CREATE TRIGGER uw_comps_updated_at
    BEFORE UPDATE ON public.uw_comps
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ── 7. INDEXES ────────────────────────────────────────────────────────────────

CREATE INDEX uw_projects_created_by_idx      ON public.uw_projects (created_by);
CREATE INDEX uw_projects_status_idx          ON public.uw_projects (status);
CREATE INDEX uw_properties_project_id_idx    ON public.uw_properties (project_id);
CREATE INDEX uw_properties_latest_deal_idx   ON public.uw_properties (latest_deal_id);
CREATE INDEX uw_deals_property_id_idx        ON public.uw_deals (property_id);
CREATE INDEX uw_deals_status_idx             ON public.uw_deals (status);
CREATE INDEX uw_documents_deal_id_idx        ON public.uw_documents (deal_id);
CREATE INDEX uw_versions_deal_id_idx         ON public.uw_versions (deal_id);
CREATE INDEX uw_comps_state_idx              ON public.uw_comps (state);
CREATE INDEX uw_comps_property_type_idx      ON public.uw_comps (property_type);
CREATE INDEX uw_comps_credit_tier_idx        ON public.uw_comps (credit_tier);
CREATE INDEX uw_comps_close_date_idx         ON public.uw_comps (close_date DESC);
