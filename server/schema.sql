CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS permissions (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'hr', 'manager', 'employee', 'intern')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employee_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  employee_code TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  phone TEXT,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  designation TEXT NOT NULL DEFAULT 'Employee',
  employment_type TEXT NOT NULL DEFAULT 'Full-Time Employee',
  joining_date DATE,
  address TEXT,
  emergency_contact TEXT,
  profile_picture TEXT,
  upi_id TEXT,
  manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
  monthly_salary NUMERIC(12, 2) NOT NULL DEFAULT 30000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL DEFAULT CURRENT_DATE,
  check_in TIMESTAMPTZ,
  check_out TIMESTAMPTZ,
  working_minutes INTEGER,
  status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'absent', 'half_day', 'leave')),
  leave_type TEXT CHECK (leave_type IN ('medical', 'casual', 'unpaid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, attendance_date)
);

CREATE TABLE IF NOT EXISTS login_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logged_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS holidays (
  id SERIAL PRIMARY KEY,
  holiday_date DATE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Indian festival',
  region TEXT NOT NULL DEFAULT 'India',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (holiday_date, name)
);

CREATE TABLE IF NOT EXISTS leave_balances (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month DATE NOT NULL,
  leave_type TEXT NOT NULL CHECK (leave_type IN ('medical', 'casual')),
  allowance NUMERIC(5, 2) NOT NULL,
  used NUMERIC(5, 2) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month, leave_type)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type TEXT NOT NULL CHECK (leave_type IN ('medical', 'casual')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days NUMERIC(5, 2) NOT NULL CHECK (days > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);

ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS upi_id TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS leave_type TEXT;
ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_leave_type_check;
ALTER TABLE attendance ADD CONSTRAINT attendance_leave_type_check
  CHECK (leave_type IN ('medical', 'casual', 'unpaid'));
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_leave_type_check;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_leave_type_check
  CHECK (leave_type IN ('medical', 'casual', 'unpaid'));

CREATE TABLE IF NOT EXISTS internal_messages (
  id BIGSERIAL PRIMARY KEY,
  employee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  leave_request_id BIGINT REFERENCES leave_requests(id) ON DELETE SET NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS salary_records (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pay_month DATE NOT NULL,
  base_salary NUMERIC(12, 2) NOT NULL,
  bonus NUMERIC(12, 2) NOT NULL DEFAULT 0,
  deductions NUMERIC(12, 2) NOT NULL DEFAULT 0,
  net_pay NUMERIC(12, 2) NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed')),
  paid_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, pay_month)
);

CREATE TABLE IF NOT EXISTS payroll (
  id BIGSERIAL PRIMARY KEY,
  pay_month DATE NOT NULL UNIQUE,
  total_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'complete')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS performance_reviews (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  review_month DATE NOT NULL,
  task_completion NUMERIC(5, 2) NOT NULL,
  productivity NUMERIC(5, 2) NOT NULL,
  quality NUMERIC(5, 2) NOT NULL,
  attendance NUMERIC(5, 2) NOT NULL,
  teamwork NUMERIC(5, 2) NOT NULL,
  communication NUMERIC(5, 2) NOT NULL,
  overall_score NUMERIC(5, 2) NOT NULL,
  feedback TEXT NOT NULL DEFAULT '',
  suggestions TEXT NOT NULL DEFAULT '',
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, review_month)
);

CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assigned_to UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'complete')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dropbox_accounts (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dropbox_account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_status_role ON users(status, role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_super_admin
  ON users (role) WHERE role = 'super_admin';
CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance(user_id, attendance_date DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_user_time ON login_events(user_id, logged_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(holiday_date);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_salary_month ON salary_records(pay_month DESC);
CREATE INDEX IF NOT EXISTS idx_performance_user_month ON performance_reviews(user_id, review_month DESC);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_internal_messages_employee_time ON internal_messages(employee_id, created_at DESC);

INSERT INTO roles (name) VALUES ('super_admin'), ('hr'), ('manager'), ('employee'), ('intern')
ON CONFLICT (name) DO NOTHING;

INSERT INTO permissions (name) VALUES
  ('employees:read'), ('employees:write'), ('employees:approve'),
  ('attendance:read'), ('attendance:write'), ('leave:review'),
  ('payroll:read'), ('payroll:write'), ('performance:write'),
  ('documents:read'), ('documents:write'), ('settings:write')
ON CONFLICT (name) DO NOTHING;

INSERT INTO departments (name) VALUES
  ('Engineering'), ('People & Culture'), ('Operations'), ('Finance'), ('Design')
ON CONFLICT (name) DO NOTHING;

INSERT INTO admin_settings (key, value) VALUES
  ('leave_policy', '{"medical": 2, "casual": 1, "carryForward": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO holidays (holiday_date, name, category, region) VALUES
  ('2026-11-09', 'Diwali', 'Indian festival', 'India'),
  ('2026-11-15', 'Chhath Puja', 'Indian festival', 'India'),
  ('2026-11-24', 'Guru Nanak Jayanti', 'Indian festival', 'India')
ON CONFLICT (holiday_date, name) DO NOTHING;

INSERT INTO holidays (holiday_date, name, category, region)
SELECT make_date(year, annual.month, annual.day), annual.name, annual.category, 'India'
FROM generate_series(2020, 2100) AS years(year)
CROSS JOIN (VALUES
  (1, 26, 'Republic Day', 'National holiday'),
  (1, 14, 'Makar Sankranti', 'Indian festival'),
  (4, 13, 'Baisakhi', 'Indian festival'),
  (8, 15, 'Independence Day', 'National holiday'),
  (10, 2, 'Gandhi Jayanti', 'National holiday'),
  (12, 25, 'Christmas', 'Indian festival')
) AS annual(month, day, name, category)
ON CONFLICT (holiday_date, name) DO NOTHING;
