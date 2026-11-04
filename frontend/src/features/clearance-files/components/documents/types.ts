export interface DocType { id: string; code: string; nameEn: string; nameAr: string; isActive: boolean }

export interface DocumentRow {
  id: string; clearanceFileId: string; documentType: { id: string; code: string; nameEn: string; nameAr: string };
  originalFilename: string; mimeType: string; fileSize: number; versionNumber: number;
  status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'VOID'; notes: string | null;
  uploadedBy: { id: string; firstName: string; lastName: string } | null; uploadedAt: string; deletedAt: string | null;
}

export interface ChecklistItem {
  requirementId: string; documentType: { id: string; code: string; nameEn: string; nameAr: string };
  isRequired: boolean; requiredBeforeStage: { id: string; code: string; nameEn: string; nameAr: string | null } | null;
  state: 'MISSING' | 'UPLOADED' | 'APPROVED' | 'REJECTED_ONLY'; satisfied: boolean; documentIds: string[];
}
