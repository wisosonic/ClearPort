import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { EnvelopeInterceptor } from './common/envelope.interceptor';
import { ENV, type Env } from './config/env';
import { DatabaseModule } from './database/prisma.module';
import { AuditService } from './modules/audit/audit.service';
import { AuthController } from './modules/auth/auth.controller';
import { JwtAuthGuard, PermissionsGuard, TenantContextInterceptor } from './modules/auth/auth.guards';
import { AuthService } from './modules/auth/auth.service';
import { TokenService } from './modules/auth/token.service';
import { BranchesController } from './modules/branches/branches.controller';
import { ActivityService } from './modules/clearance-files/activity.service';
import { FilesController, ReferenceController, ShipmentsController } from './modules/clearance-files/files.controller';
import { FilesService } from './modules/clearance-files/files.service';
import { ShipmentsService } from './modules/clearance-files/shipments.service';
import { ClientsController } from './modules/clients/clients.controller';
import { ClientsService } from './modules/clients/clients.service';
import { PartiesController } from './modules/clients/parties.controller';
import { LocalStorageService } from './infrastructure/storage/local-storage.service';
import { MalwareScanner } from './infrastructure/storage/malware-scanner';
import { UploadInterceptor } from './infrastructure/storage/upload.interceptor';
import { DocumentsController } from './modules/documents/documents.controller';
import { DocumentsService } from './modules/documents/documents.service';
import { RequirementsService } from './modules/documents/requirements.service';
import { TasksController } from './modules/tasks/tasks.controller';
import { TasksService } from './modules/tasks/tasks.service';
import { TransitionsService } from './modules/workflow/transitions.service';
import { TransitionsController, WorkflowAdminController } from './modules/workflow/workflow.controller';
import { WorkflowAdminService } from './modules/workflow/workflow-admin.service';
import { ExpensesController } from './modules/finance/expenses.controller';
import { ExpensesService } from './modules/finance/expenses.service';
import { InvoicesController } from './modules/finance/invoices.controller';
import { InvoicesService } from './modules/finance/invoices.service';
import { PaymentsController } from './modules/finance/payments.controller';
import { PaymentsService } from './modules/finance/payments.service';
import { ReportsController } from './modules/finance/reports.controller';
import { ReportsService } from './modules/finance/reports.service';
import { PdfService } from './infrastructure/pdf/pdf.service';
import { PrintController } from './modules/reports/print.controller';
import { PrintService } from './modules/reports/print.service';
import { HousekeepingService } from './infrastructure/queue/housekeeping.service';
import { JobQueueService } from './infrastructure/queue/job-queue.service';
import { JobWorkerService } from './infrastructure/queue/job-worker.service';
import { TaskRemindersService } from './modules/tasks/task-reminders.service';
import { DashboardService } from './modules/reports/dashboard.service';
import { ExportService } from './modules/reports/export.service';
import { OperationsReportsService } from './modules/reports/operations-reports.service';
import { ReportsOpsController } from './modules/reports/reports-ops.controller';
import { AuditController } from './modules/audit/audit.controller';
import { AccountingService } from './modules/finance/accounting.service';
import { FinanceSetupService } from './modules/finance/finance-setup.service';
import { RatesService } from './modules/finance/rates.service';
import { AccountingController, FinanceSetupController } from './modules/finance/setup.controller';
import { HealthController } from './modules/health/health.controller';
import { RolesController } from './modules/roles/roles.controller';
import { ProvisioningService } from './modules/tenants/provisioning.service';
import { TenantsController } from './modules/tenants/tenants.controller';
import { UsersController } from './modules/users/users.controller';
import { UsersService } from './modules/users/users.service';

@Global()
@Module({})
export class ConfigModule {
  static forRoot(env: Env): DynamicModule {
    return { module: ConfigModule, providers: [{ provide: ENV, useValue: env }], exports: [ENV] };
  }
}

@Module({
  imports: [
    DatabaseModule,
    JwtModule.register({}),
    // Default per-IP limit; credential endpoints override with a strict limit (spec 9.4).
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: () => Number(process.env.RATE_LIMIT_DEFAULT ?? 300) }],
    }),
  ],
  controllers: [
    HealthController, AuthController, TenantsController, BranchesController, UsersController, RolesController,
    ClientsController, PartiesController, FilesController, ShipmentsController, ReferenceController, DocumentsController,
    WorkflowAdminController, TransitionsController, TasksController,
    FinanceSetupController, AccountingController, ExpensesController, InvoicesController, PaymentsController, ReportsController, ReportsOpsController, PrintController, AuditController,
  ],
  providers: [
    AuditService, TokenService, AuthService, UsersService, ProvisioningService, ClientsService,
    FilesService, ShipmentsService, ActivityService,
    LocalStorageService, MalwareScanner, UploadInterceptor, DocumentsService, RequirementsService,
    WorkflowAdminService, TransitionsService, TasksService,
    RatesService, AccountingService, FinanceSetupService, ExpensesService, InvoicesService, PaymentsService, ReportsService,
    OperationsReportsService, DashboardService, ExportService, PdfService, PrintService,
    JobQueueService, JobWorkerService, HousekeepingService, TaskRemindersService,
    // Order matters: rate-limit → authenticate (+ tenant verification) → authorise.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {
  static register(env: Env): DynamicModule {
    return { module: AppModule, imports: [ConfigModule.forRoot(env)] };
  }
}
