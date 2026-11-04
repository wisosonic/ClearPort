-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "legalName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "defaultCurrency" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Beirut',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "tenant_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "branchId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "tenant_users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "tenant_users_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "tenant_users_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "branches" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "branches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "description" TEXT
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    PRIMARY KEY ("roleId", "permissionId"),
    CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "branchId" TEXT,
    CONSTRAINT "user_roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "user_roles_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "tenant_users" ("tenantId", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_roles_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "refresh_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "replacedById" TEXT,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refresh_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "refresh_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "clientCode" TEXT NOT NULL,
    "clientType" TEXT NOT NULL DEFAULT 'COMPANY',
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "taxNumber" TEXT,
    "registrationNumber" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "countryCode" TEXT,
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 0,
    "creditLimit" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "clients_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "client_contacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "client_contacts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "client_contacts_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "clients" ("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "business_parties" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "partyType" TEXT NOT NULL,
    "taxNumber" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "countryCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "business_parties_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "clearance_files" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "fileNumber" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "branchId" TEXT,
    "assignedTo" TEXT,
    "workflowTemplateId" TEXT,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedArrivalAt" DATETIME,
    "closedAt" DATETIME,
    "currentStageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "customsReference" TEXT,
    "internalNotes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "clearance_files_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "clearance_files_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "clients" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "clearance_files_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "clearance_files_tenantId_assignedTo_fkey" FOREIGN KEY ("tenantId", "assignedTo") REFERENCES "tenant_users" ("tenantId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "clearance_files_tenantId_createdBy_fkey" FOREIGN KEY ("tenantId", "createdBy") REFERENCES "tenant_users" ("tenantId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "clearance_files_tenantId_workflowTemplateId_fkey" FOREIGN KEY ("tenantId", "workflowTemplateId") REFERENCES "workflow_templates" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "clearance_files_tenantId_currentStageId_fkey" FOREIGN KEY ("tenantId", "currentStageId") REFERENCES "workflow_stages" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "number_sequences" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "number_sequences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "clearanceFileId" TEXT NOT NULL,
    "shipmentType" TEXT NOT NULL DEFAULT 'SEA',
    "vesselName" TEXT,
    "voyageNumber" TEXT,
    "billOfLadingNumber" TEXT,
    "masterBlNumber" TEXT,
    "houseBlNumber" TEXT,
    "shippingAgentId" TEXT,
    "freightForwarderId" TEXT,
    "originPortId" TEXT,
    "destinationPortId" TEXT,
    "etd" DATETIME,
    "eta" DATETIME,
    "actualArrivalAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "shipments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "shipments_tenantId_clearanceFileId_fkey" FOREIGN KEY ("tenantId", "clearanceFileId") REFERENCES "clearance_files" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "shipments_tenantId_shippingAgentId_fkey" FOREIGN KEY ("tenantId", "shippingAgentId") REFERENCES "business_parties" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "shipments_tenantId_freightForwarderId_fkey" FOREIGN KEY ("tenantId", "freightForwarderId") REFERENCES "business_parties" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "shipments_originPortId_fkey" FOREIGN KEY ("originPortId") REFERENCES "ports" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "shipments_destinationPortId_fkey" FOREIGN KEY ("destinationPortId") REFERENCES "ports" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "containers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "containerNumber" TEXT NOT NULL,
    "containerType" TEXT,
    "sealNumber" TEXT,
    "grossWeight" TEXT,
    "netWeight" TEXT,
    "packageCount" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "containers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "containers_tenantId_shipmentId_fkey" FOREIGN KEY ("tenantId", "shipmentId") REFERENCES "shipments" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "goods_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "hsCodeId" TEXT,
    "countryOfOrigin" TEXT,
    "quantity" TEXT,
    "unitOfMeasure" TEXT,
    "grossWeight" TEXT,
    "netWeight" TEXT,
    "unitPrice" TEXT,
    "lineTotal" TEXT,
    "currencyCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "goods_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "goods_items_tenantId_shipmentId_fkey" FOREIGN KEY ("tenantId", "shipmentId") REFERENCES "shipments" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "goods_items_hsCodeId_fkey" FOREIGN KEY ("hsCodeId") REFERENCES "hs_codes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "goods_items_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "currencies" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "portType" TEXT NOT NULL DEFAULT 'SEA'
);

-- CreateTable
CREATE TABLE "document_types" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "document_types_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "clearanceFileId" TEXT NOT NULL,
    "documentTypeId" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL DEFAULT 1,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "notes" TEXT,
    "deletedAt" DATETIME,
    CONSTRAINT "documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "documents_tenantId_clearanceFileId_fkey" FOREIGN KEY ("tenantId", "clearanceFileId") REFERENCES "clearance_files" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "documents_documentTypeId_fkey" FOREIGN KEY ("documentTypeId") REFERENCES "document_types" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT,
    "fileSize" BIGINT,
    "checksum" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "document_versions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "document_versions_tenantId_documentId_fkey" FOREIGN KEY ("tenantId", "documentId") REFERENCES "documents" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "document_requirements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "documentTypeId" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "isRequiredBeforeStageId" TEXT,
    "appliesTo" TEXT,
    "conditions" JSONB,
    CONSTRAINT "document_requirements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "document_requirements_documentTypeId_fkey" FOREIGN KEY ("documentTypeId") REFERENCES "document_types" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "document_requirements_tenantId_isRequiredBeforeStageId_fkey" FOREIGN KEY ("tenantId", "isRequiredBeforeStageId") REFERENCES "workflow_stages" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workflow_templates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "workflow_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workflow_stages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "workflowTemplateId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "isTerminal" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "workflow_stages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "workflow_stages_tenantId_workflowTemplateId_fkey" FOREIGN KEY ("tenantId", "workflowTemplateId") REFERENCES "workflow_templates" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workflow_transitions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "workflowTemplateId" TEXT NOT NULL,
    "fromStageId" TEXT NOT NULL,
    "toStageId" TEXT NOT NULL,
    "requiredPermission" TEXT,
    "requiresDocumentCheck" BOOLEAN NOT NULL DEFAULT false,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "requiresReason" BOOLEAN NOT NULL DEFAULT false,
    "requiredTaskCheck" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "workflow_transitions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "workflow_transitions_tenantId_workflowTemplateId_fkey" FOREIGN KEY ("tenantId", "workflowTemplateId") REFERENCES "workflow_templates" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "workflow_transitions_tenantId_fromStageId_fkey" FOREIGN KEY ("tenantId", "fromStageId") REFERENCES "workflow_stages" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "workflow_transitions_tenantId_toStageId_fkey" FOREIGN KEY ("tenantId", "toStageId") REFERENCES "workflow_stages" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "file_status_history" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "clearanceFileId" TEXT NOT NULL,
    "fromStageId" TEXT,
    "toStageId" TEXT NOT NULL,
    "changedBy" TEXT NOT NULL,
    "reason" TEXT,
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "file_status_history_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "file_status_history_tenantId_clearanceFileId_fkey" FOREIGN KEY ("tenantId", "clearanceFileId") REFERENCES "clearance_files" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "file_status_history_tenantId_fromStageId_fkey" FOREIGN KEY ("tenantId", "fromStageId") REFERENCES "workflow_stages" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "file_status_history_tenantId_toStageId_fkey" FOREIGN KEY ("tenantId", "toStageId") REFERENCES "workflow_stages" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "clearanceFileId" TEXT,
    "assignedTo" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "dueAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "tasks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "tasks_tenantId_clearanceFileId_fkey" FOREIGN KEY ("tenantId", "clearanceFileId") REFERENCES "clearance_files" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "tasks_tenantId_assignedTo_fkey" FOREIGN KEY ("tenantId", "assignedTo") REFERENCES "tenant_users" ("tenantId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "tasks_tenantId_createdBy_fkey" FOREIGN KEY ("tenantId", "createdBy") REFERENCES "tenant_users" ("tenantId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "file_activities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "clearanceFileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activityType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "file_activities_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "file_activities_tenantId_clearanceFileId_fkey" FOREIGN KEY ("tenantId", "clearanceFileId") REFERENCES "clearance_files" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "metadata" JSONB,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "beforeData" JSONB,
    "afterData" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "currencies" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimalPlaces" INTEGER NOT NULL DEFAULT 2,
    "isActive" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "rate" TEXT NOT NULL,
    "convention" TEXT NOT NULL DEFAULT 'BASE_PER_FOREIGN',
    "effectiveAt" DATETIME NOT NULL,
    "source" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "exchange_rates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "financial_categories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryType" TEXT NOT NULL,
    "costTreatment" TEXT NOT NULL DEFAULT 'PASS_THROUGH',
    "isBillableToClient" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "financial_categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "clearanceFileId" TEXT,
    "categoryId" TEXT NOT NULL,
    "vendorId" TEXT,
    "description" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "exchangeRate" TEXT NOT NULL,
    "rateConvention" TEXT NOT NULL DEFAULT 'BASE_PER_FOREIGN',
    "rateSource" TEXT,
    "baseAmount" TEXT NOT NULL,
    "expenseDate" DATETIME NOT NULL,
    "paidBy" TEXT NOT NULL DEFAULT 'OFFICE',
    "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "recordedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "expenses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "expenses_tenantId_clearanceFileId_fkey" FOREIGN KEY ("tenantId", "clearanceFileId") REFERENCES "clearance_files" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "expenses_tenantId_categoryId_fkey" FOREIGN KEY ("tenantId", "categoryId") REFERENCES "financial_categories" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "expenses_tenantId_vendorId_fkey" FOREIGN KEY ("tenantId", "vendorId") REFERENCES "business_parties" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "expenses_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "currencies" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "clearanceFileId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "invoiceType" TEXT NOT NULL DEFAULT 'STANDARD',
    "issueDate" DATETIME,
    "dueDate" DATETIME,
    "currencyCode" TEXT NOT NULL,
    "subtotal" TEXT NOT NULL,
    "discount" TEXT NOT NULL DEFAULT '0',
    "taxAmount" TEXT NOT NULL DEFAULT '0',
    "totalAmount" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "issuedAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancelReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "invoices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoices_tenantId_clearanceFileId_fkey" FOREIGN KEY ("tenantId", "clearanceFileId") REFERENCES "clearance_files" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoices_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "clients" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoices_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "currencies" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "categoryId" TEXT,
    "quantity" TEXT NOT NULL,
    "unitPrice" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    CONSTRAINT "invoice_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_items_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "invoices" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_items_tenantId_categoryId_fkey" FOREIGN KEY ("tenantId", "categoryId") REFERENCES "financial_categories" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT,
    "clearanceFileId" TEXT,
    "paymentNumber" TEXT NOT NULL,
    "paymentType" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "exchangeRate" TEXT NOT NULL,
    "rateConvention" TEXT NOT NULL DEFAULT 'BASE_PER_FOREIGN',
    "rateSource" TEXT,
    "baseAmount" TEXT NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "cashAccountId" TEXT NOT NULL,
    "referenceNumber" TEXT,
    "paymentDate" DATETIME NOT NULL,
    "receivedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payments_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "clients" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payments_tenantId_clearanceFileId_fkey" FOREIGN KEY ("tenantId", "clearanceFileId") REFERENCES "clearance_files" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payments_tenantId_cashAccountId_fkey" FOREIGN KEY ("tenantId", "cashAccountId") REFERENCES "cash_accounts" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payments_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "currencies" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "allocatedAmount" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_allocations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_allocations_tenantId_paymentId_fkey" FOREIGN KEY ("tenantId", "paymentId") REFERENCES "payments" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_allocations_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "invoices" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "cash_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "ledgerAccountId" TEXT,
    CONSTRAINT "cash_accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cash_accounts_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "currencies" ("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cash_accounts_tenantId_ledgerAccountId_fkey" FOREIGN KEY ("tenantId", "ledgerAccountId") REFERENCES "chart_of_accounts" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "chart_of_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "parentId" TEXT,
    "currencyCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "chart_of_accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "chart_of_accounts_tenantId_parentId_fkey" FOREIGN KEY ("tenantId", "parentId") REFERENCES "chart_of_accounts" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "entryNumber" TEXT NOT NULL,
    "entryDate" DATETIME NOT NULL,
    "description" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "reversalOfId" TEXT,
    "createdBy" TEXT NOT NULL,
    "postedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "journal_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "journal_entries_tenantId_reversalOfId_fkey" FOREIGN KEY ("tenantId", "reversalOfId") REFERENCES "journal_entries" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "journal_entry_lines" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" TEXT NOT NULL DEFAULT '0',
    "credit" TEXT NOT NULL DEFAULT '0',
    "currencyCode" TEXT NOT NULL,
    "exchangeRate" TEXT NOT NULL,
    "rateConvention" TEXT NOT NULL DEFAULT 'BASE_PER_FOREIGN',
    "baseDebit" TEXT NOT NULL DEFAULT '0',
    "baseCredit" TEXT NOT NULL DEFAULT '0',
    "clearanceFileId" TEXT,
    CONSTRAINT "journal_entry_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "journal_entry_lines_tenantId_journalEntryId_fkey" FOREIGN KEY ("tenantId", "journalEntryId") REFERENCES "journal_entries" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "journal_entry_lines_tenantId_accountId_fkey" FOREIGN KEY ("tenantId", "accountId") REFERENCES "chart_of_accounts" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "journal_entry_lines_tenantId_clearanceFileId_fkey" FOREIGN KEY ("tenantId", "clearanceFileId") REFERENCES "clearance_files" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "hs_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "hs_code_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hsCodeId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "description" TEXT,
    "effectiveFrom" DATETIME NOT NULL,
    "effectiveTo" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "hs_code_versions_hsCodeId_fkey" FOREIGN KEY ("hsCodeId") REFERENCES "hs_codes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "countries" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "units_of_measure" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    CONSTRAINT "system_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT,
    "code" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    CONSTRAINT "notification_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" DATETIME,
    "lockedBy" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "jobs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "tenant_users_userId_idx" ON "tenant_users"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_users_tenantId_userId_key" ON "tenant_users"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_users_tenantId_id_key" ON "tenant_users"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "branches_tenantId_code_key" ON "branches"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "branches_tenantId_id_key" ON "branches"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenantId_code_key" ON "roles"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "user_roles_tenantId_userId_idx" ON "user_roles"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_tenantId_userId_roleId_key" ON "user_roles"("tenantId", "userId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_sessions_tokenHash_key" ON "refresh_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_sessions_userId_idx" ON "refresh_sessions"("userId");

-- CreateIndex
CREATE INDEX "refresh_sessions_familyId_idx" ON "refresh_sessions"("familyId");

-- CreateIndex
CREATE INDEX "clients_tenantId_name_idx" ON "clients"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "clients_tenantId_clientCode_key" ON "clients"("tenantId", "clientCode");

-- CreateIndex
CREATE UNIQUE INDEX "clients_tenantId_id_key" ON "clients"("tenantId", "id");

-- CreateIndex
CREATE INDEX "client_contacts_tenantId_clientId_idx" ON "client_contacts"("tenantId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "client_contacts_tenantId_id_key" ON "client_contacts"("tenantId", "id");

-- CreateIndex
CREATE INDEX "business_parties_tenantId_name_idx" ON "business_parties"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "business_parties_tenantId_id_key" ON "business_parties"("tenantId", "id");

-- CreateIndex
CREATE INDEX "clearance_files_tenantId_status_idx" ON "clearance_files"("tenantId", "status");

-- CreateIndex
CREATE INDEX "clearance_files_tenantId_clientId_idx" ON "clearance_files"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "clearance_files_tenantId_assignedTo_idx" ON "clearance_files"("tenantId", "assignedTo");

-- CreateIndex
CREATE INDEX "clearance_files_tenantId_createdAt_idx" ON "clearance_files"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "clearance_files_tenantId_customsReference_idx" ON "clearance_files"("tenantId", "customsReference");

-- CreateIndex
CREATE UNIQUE INDEX "clearance_files_tenantId_fileNumber_key" ON "clearance_files"("tenantId", "fileNumber");

-- CreateIndex
CREATE UNIQUE INDEX "clearance_files_tenantId_id_key" ON "clearance_files"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "number_sequences_tenantId_docType_year_key" ON "number_sequences"("tenantId", "docType", "year");

-- CreateIndex
CREATE INDEX "shipments_tenantId_clearanceFileId_idx" ON "shipments"("tenantId", "clearanceFileId");

-- CreateIndex
CREATE INDEX "shipments_tenantId_billOfLadingNumber_idx" ON "shipments"("tenantId", "billOfLadingNumber");

-- CreateIndex
CREATE INDEX "shipments_tenantId_masterBlNumber_idx" ON "shipments"("tenantId", "masterBlNumber");

-- CreateIndex
CREATE INDEX "shipments_tenantId_houseBlNumber_idx" ON "shipments"("tenantId", "houseBlNumber");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_tenantId_id_key" ON "shipments"("tenantId", "id");

-- CreateIndex
CREATE INDEX "containers_tenantId_containerNumber_idx" ON "containers"("tenantId", "containerNumber");

-- CreateIndex
CREATE UNIQUE INDEX "containers_tenantId_id_key" ON "containers"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "containers_tenantId_shipmentId_containerNumber_key" ON "containers"("tenantId", "shipmentId", "containerNumber");

-- CreateIndex
CREATE INDEX "goods_items_tenantId_shipmentId_idx" ON "goods_items"("tenantId", "shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "goods_items_tenantId_id_key" ON "goods_items"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ports_code_key" ON "ports"("code");

-- CreateIndex
CREATE INDEX "ports_countryCode_idx" ON "ports"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "document_types_tenantId_code_key" ON "document_types"("tenantId", "code");

-- CreateIndex
CREATE INDEX "documents_tenantId_clearanceFileId_idx" ON "documents"("tenantId", "clearanceFileId");

-- CreateIndex
CREATE UNIQUE INDEX "documents_tenantId_id_key" ON "documents"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_tenantId_documentId_versionNumber_key" ON "document_versions"("tenantId", "documentId", "versionNumber");

-- CreateIndex
CREATE INDEX "document_requirements_tenantId_fileType_idx" ON "document_requirements"("tenantId", "fileType");

-- CreateIndex
CREATE UNIQUE INDEX "document_requirements_tenantId_id_key" ON "document_requirements"("tenantId", "id");

-- CreateIndex
CREATE INDEX "workflow_templates_tenantId_fileType_idx" ON "workflow_templates"("tenantId", "fileType");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_templates_tenantId_id_key" ON "workflow_templates"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_stages_tenantId_id_key" ON "workflow_stages"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_stages_tenantId_workflowTemplateId_code_key" ON "workflow_stages"("tenantId", "workflowTemplateId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_stages_tenantId_workflowTemplateId_sequence_key" ON "workflow_stages"("tenantId", "workflowTemplateId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_transitions_tenantId_workflowTemplateId_fromStageId_toStageId_key" ON "workflow_transitions"("tenantId", "workflowTemplateId", "fromStageId", "toStageId");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_transitions_tenantId_id_key" ON "workflow_transitions"("tenantId", "id");

-- CreateIndex
CREATE INDEX "file_status_history_tenantId_clearanceFileId_changedAt_idx" ON "file_status_history"("tenantId", "clearanceFileId", "changedAt");

-- CreateIndex
CREATE INDEX "tasks_tenantId_assignedTo_dueAt_idx" ON "tasks"("tenantId", "assignedTo", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_tenantId_clearanceFileId_idx" ON "tasks"("tenantId", "clearanceFileId");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_tenantId_id_key" ON "tasks"("tenantId", "id");

-- CreateIndex
CREATE INDEX "file_activities_tenantId_clearanceFileId_createdAt_idx" ON "file_activities"("tenantId", "clearanceFileId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "notifications_tenantId_userId_createdAt_idx" ON "notifications"("tenantId", "userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_entityType_entityId_idx" ON "audit_logs"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_createdAt_idx" ON "audit_logs"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "exchange_rates_tenantId_fromCurrency_toCurrency_effectiveAt_idx" ON "exchange_rates"("tenantId", "fromCurrency", "toCurrency", "effectiveAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_tenantId_fromCurrency_toCurrency_effectiveAt_key" ON "exchange_rates"("tenantId", "fromCurrency", "toCurrency", "effectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "financial_categories_tenantId_id_key" ON "financial_categories"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_categories_tenantId_name_key" ON "financial_categories"("tenantId", "name");

-- CreateIndex
CREATE INDEX "expenses_tenantId_clearanceFileId_idx" ON "expenses"("tenantId", "clearanceFileId");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_tenantId_id_key" ON "expenses"("tenantId", "id");

-- CreateIndex
CREATE INDEX "invoices_tenantId_clientId_idx" ON "invoices"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "invoices_tenantId_clearanceFileId_idx" ON "invoices"("tenantId", "clearanceFileId");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenantId_invoiceNumber_key" ON "invoices"("tenantId", "invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenantId_id_key" ON "invoices"("tenantId", "id");

-- CreateIndex
CREATE INDEX "invoice_items_tenantId_invoiceId_idx" ON "invoice_items"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "payments_tenantId_clientId_idx" ON "payments"("tenantId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenantId_paymentNumber_key" ON "payments"("tenantId", "paymentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenantId_id_key" ON "payments"("tenantId", "id");

-- CreateIndex
CREATE INDEX "payment_allocations_tenantId_paymentId_idx" ON "payment_allocations"("tenantId", "paymentId");

-- CreateIndex
CREATE INDEX "payment_allocations_tenantId_invoiceId_idx" ON "payment_allocations"("tenantId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "cash_accounts_tenantId_id_key" ON "cash_accounts"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_accounts_tenantId_name_key" ON "cash_accounts"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "chart_of_accounts_tenantId_accountCode_key" ON "chart_of_accounts"("tenantId", "accountCode");

-- CreateIndex
CREATE UNIQUE INDEX "chart_of_accounts_tenantId_id_key" ON "chart_of_accounts"("tenantId", "id");

-- CreateIndex
CREATE INDEX "journal_entries_tenantId_status_idx" ON "journal_entries"("tenantId", "status");

-- CreateIndex
CREATE INDEX "journal_entries_tenantId_sourceType_sourceId_idx" ON "journal_entries"("tenantId", "sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_tenantId_entryNumber_key" ON "journal_entries"("tenantId", "entryNumber");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_tenantId_id_key" ON "journal_entries"("tenantId", "id");

-- CreateIndex
CREATE INDEX "journal_entry_lines_tenantId_journalEntryId_idx" ON "journal_entry_lines"("tenantId", "journalEntryId");

-- CreateIndex
CREATE INDEX "journal_entry_lines_tenantId_accountId_idx" ON "journal_entry_lines"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "journal_entry_lines_tenantId_clearanceFileId_idx" ON "journal_entry_lines"("tenantId", "clearanceFileId");

-- CreateIndex
CREATE UNIQUE INDEX "hs_codes_jurisdiction_code_key" ON "hs_codes"("jurisdiction", "code");

-- CreateIndex
CREATE UNIQUE INDEX "hs_code_versions_hsCodeId_version_key" ON "hs_code_versions"("hsCodeId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_tenantId_key_key" ON "system_settings"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_tenantId_code_locale_key" ON "notification_templates"("tenantId", "code", "locale");

-- CreateIndex
CREATE INDEX "jobs_status_runAt_idx" ON "jobs"("status", "runAt");

-- CreateIndex
CREATE INDEX "jobs_tenantId_type_idx" ON "jobs"("tenantId", "type");
