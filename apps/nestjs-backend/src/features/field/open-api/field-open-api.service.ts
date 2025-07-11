import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CellValueType,
  FieldKeyType,
  FieldOpBuilder,
  FieldType,
  generateFieldId,
  generateOperationId,
  IFieldRo,
} from '@teable/core';
import type {
  IFieldVo,
  IConvertFieldRo,
  IUpdateFieldRo,
  IOtOperation,
  IColumnMeta,
  ILinkFieldOptions,
  IGetFieldsQuery,
} from '@teable/core';
import { PrismaService } from '@teable/db-main-prisma';
import type { IDuplicateFieldRo } from '@teable/openapi';
import { instanceToPlain } from 'class-transformer';
import { Knex } from 'knex';
import { groupBy, omit, pick } from 'lodash';
import { InjectModel } from 'nest-knexjs';
import { ClsService } from 'nestjs-cls';
import { ThresholdConfig, IThresholdConfig } from '../../../configs/threshold.config';
import { EventEmitterService } from '../../../event-emitter/event-emitter.service';
import { Events } from '../../../event-emitter/events';
import type { IClsStore } from '../../../types/cls';
import { Timing } from '../../../utils/timing';
import { FieldCalculationService } from '../../calculation/field-calculation.service';
import type { IOpsMap } from '../../calculation/utils/compose-maps';
import { GraphService } from '../../graph/graph.service';
import { RecordOpenApiService } from '../../record/open-api/record-open-api.service';
import { RecordService } from '../../record/record.service';
import { TableIndexService } from '../../table/table-index.service';
import { ViewOpenApiService } from '../../view/open-api/view-open-api.service';
import { ViewService } from '../../view/view.service';
import { FieldConvertingService } from '../field-calculate/field-converting.service';
import { FieldCreatingService } from '../field-calculate/field-creating.service';
import { FieldDeletingService } from '../field-calculate/field-deleting.service';
import { FieldSupplementService } from '../field-calculate/field-supplement.service';
import { FieldViewSyncService } from '../field-calculate/field-view-sync.service';
import { FieldService } from '../field.service';
import type { IFieldInstance } from '../model/factory';
import {
  createFieldInstanceByRaw,
  createFieldInstanceByVo,
  rawField2FieldObj,
} from '../model/factory';
@Injectable()
export class FieldOpenApiService {
  private logger = new Logger(FieldOpenApiService.name);
  constructor(
    private readonly graphService: GraphService,
    private readonly prismaService: PrismaService,
    private readonly fieldService: FieldService,
    private readonly viewService: ViewService,
    private readonly viewOpenApiService: ViewOpenApiService,
    private readonly fieldCreatingService: FieldCreatingService,
    private readonly fieldDeletingService: FieldDeletingService,
    private readonly fieldConvertingService: FieldConvertingService,
    private readonly fieldSupplementService: FieldSupplementService,
    private readonly fieldCalculationService: FieldCalculationService,
    private readonly fieldViewSyncService: FieldViewSyncService,
    private readonly recordService: RecordService,
    private readonly eventEmitterService: EventEmitterService,
    private readonly cls: ClsService<IClsStore>,
    private readonly tableIndexService: TableIndexService,
    private readonly recordOpenApiService: RecordOpenApiService,
    @InjectModel('CUSTOM_KNEX') private readonly knex: Knex,
    @ThresholdConfig() private readonly thresholdConfig: IThresholdConfig
  ) {}

  async planField(tableId: string, fieldId: string) {
    return await this.graphService.planField(tableId, fieldId);
  }

  async planFieldCreate(tableId: string, fieldRo: IFieldRo) {
    return await this.graphService.planFieldCreate(tableId, fieldRo);
  }

  // need add delete relative check
  async planFieldConvert(tableId: string, fieldId: string, updateFieldRo: IConvertFieldRo) {
    return await this.graphService.planFieldConvert(tableId, fieldId, updateFieldRo);
  }

  async getFields(tableId: string, query: IGetFieldsQuery) {
    return await this.fieldService.getFieldsByQuery(tableId, {
      ...query,
      filterHidden: query.filterHidden == null ? true : query.filterHidden,
    });
  }

  private async validateLookupField(field: IFieldInstance) {
    if (field.lookupOptions) {
      const { foreignTableId, lookupFieldId, linkFieldId } = field.lookupOptions;
      const foreignField = await this.prismaService.txClient().field.findFirst({
        where: { tableId: foreignTableId, id: lookupFieldId, deletedTime: null },
        select: { id: true },
      });

      if (!foreignField) {
        return false;
      }
      const linkField = await this.prismaService.txClient().field.findFirst({
        where: { id: linkFieldId, deletedTime: null },
        select: { id: true, options: true },
      });
      if (!linkField) {
        return false;
      }
      const linkOptions = JSON.parse(linkField?.options as string) as ILinkFieldOptions;
      return linkOptions.foreignTableId === foreignTableId;
    }
    return true;
  }

  private async markError(tableId: string, field: IFieldInstance, hasError: boolean) {
    if (hasError) {
      !field.hasError && (await this.fieldService.markError(tableId, [field.id], true));
    } else {
      field.hasError && (await this.fieldService.markError(tableId, [field.id], false));
    }
  }

  private async checkAndUpdateError(tableId: string, field: IFieldInstance) {
    const fieldReferenceIds = this.fieldSupplementService.getFieldReferenceIds(field);
    const refFields = await this.prismaService.txClient().field.findMany({
      where: { id: { in: fieldReferenceIds }, deletedTime: null },
      select: { id: true },
    });

    if (refFields.length !== fieldReferenceIds.length) {
      await this.markError(tableId, field, true);
      return;
    }

    const curReference = await this.prismaService.txClient().reference.findMany({
      where: {
        toFieldId: field.id,
      },
    });
    const missingReferenceIds = fieldReferenceIds.filter(
      (refId) => !curReference.find((ref) => ref.fromFieldId === refId)
    );

    for (const refId of missingReferenceIds) {
      await this.prismaService.txClient().reference.create({
        data: {
          fromFieldId: refId,
          toFieldId: field.id,
        },
      });
    }

    if (field.lookupOptions) {
      const isValid = await this.validateLookupField(field);
      await this.markError(tableId, field, !isValid);
    } else {
      await this.markError(tableId, field, false);
    }
  }

  async restoreReference(references: string[]) {
    const fieldRaws = await this.prismaService.txClient().field.findMany({
      where: { id: { in: references }, deletedTime: null },
    });

    for (const refFieldRaw of fieldRaws) {
      const refField = createFieldInstanceByRaw(refFieldRaw);
      await this.checkAndUpdateError(refFieldRaw.tableId, refField);
    }
  }

  @Timing()
  async createFields(
    tableId: string,
    fields: (IFieldVo & { columnMeta?: IColumnMeta; references?: string[] })[]
  ) {
    const newFields = await this.prismaService.$tx(async () => {
      const newFields: { tableId: string; field: IFieldInstance }[] = [];
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        const { columnMeta, references, ...fieldVo } = field;

        const fieldInstance = createFieldInstanceByVo(fieldVo);

        const createResult = await this.fieldCreatingService.alterCreateField(
          tableId,
          fieldInstance,
          columnMeta
        );

        if (references) {
          await this.restoreReference(references);
        }

        newFields.push(...createResult);
      }

      return newFields;
    });

    await this.prismaService.$tx(
      async () => {
        for (const { tableId, field } of newFields) {
          if (field.isComputed) {
            await this.fieldCalculationService.calculateFields(tableId, [field.id]);
            await this.fieldService.resolvePending(tableId, [field.id]);
          }
        }
      },
      { timeout: this.thresholdConfig.bigTransactionTimeout }
    );
  }

  private async getFieldReferenceMap(fieldIds: string[]) {
    const referencesRaw = await this.prismaService.reference.findMany({
      where: {
        fromFieldId: { in: fieldIds },
      },
      select: {
        fromFieldId: true,
        toFieldId: true,
      },
    });
    return groupBy(referencesRaw, 'fromFieldId');
  }

  @Timing()
  async createField(tableId: string, fieldRo: IFieldRo, windowId?: string) {
    const fieldVo = await this.fieldSupplementService.prepareCreateField(tableId, fieldRo);
    const fieldInstance = createFieldInstanceByVo(fieldVo);
    const columnMeta = fieldRo.order && {
      [fieldRo.order.viewId]: { order: fieldRo.order.orderIndex },
    };
    const newFields = await this.prismaService.$tx(async () => {
      return await this.fieldCreatingService.alterCreateField(tableId, fieldInstance, columnMeta);
    });

    await this.prismaService.$tx(
      async () => {
        for (const { tableId, field } of newFields) {
          if (field.isComputed) {
            await this.fieldCalculationService.calculateFields(tableId, [field.id]);
            await this.fieldService.resolvePending(tableId, [field.id]);
          }
        }
      },
      { timeout: this.thresholdConfig.bigTransactionTimeout }
    );

    for (const { tableId, field } of newFields) {
      await this.tableIndexService.createSearchFieldSingleIndex(tableId, field);
    }

    const referenceMap = await this.getFieldReferenceMap([fieldVo.id]);

    this.eventEmitterService.emitAsync(Events.OPERATION_FIELDS_CREATE, {
      windowId,
      tableId,
      userId: this.cls.get('user.id'),
      fields: [
        {
          ...fieldVo,
          columnMeta,
          references: referenceMap[fieldVo.id]?.map((ref) => ref.toFieldId),
        },
      ],
    });

    return fieldVo;
  }

  @Timing()
  async deleteFields(tableId: string, fieldIds: string[], windowId?: string) {
    const fieldRaws = await this.prismaService.field.findMany({
      where: { tableId, id: { in: fieldIds }, deletedTime: null },
    });
    const fieldVos = fieldIds
      .map((id) => rawField2FieldObj(fieldRaws.find((raw) => raw.id === id)!))
      .filter(Boolean);
    const fields = fieldVos.map(createFieldInstanceByVo);

    if (fields.length !== fieldIds.length) {
      const notExistField = fieldIds.find((id) => !fields.find((field) => field.id === id));
      throw new NotFoundException(`Field ${notExistField} not found`);
    }

    const nonComputedFields = fields.filter((field) => !field.isComputed);
    const records = await this.recordService.getRecordsFields(tableId, {
      projection: nonComputedFields.map((field) => field.id),
      fieldKeyType: FieldKeyType.Id,
      take: -1,
    });

    const columnsMeta = await this.viewService.getColumnsMetaMap(tableId, fieldIds);
    const referenceMap = await this.getFieldReferenceMap(fieldIds);

    await this.prismaService.$tx(async () => {
      await this.fieldViewSyncService.deleteDependenciesByFieldIds(
        tableId,
        fields.map((f) => f.id)
      );
      for (const field of fields) {
        await this.fieldDeletingService.alterDeleteField(tableId, field);
      }
    });

    this.eventEmitterService.emitAsync(Events.OPERATION_FIELDS_DELETE, {
      operationId: generateOperationId(),
      windowId,
      tableId,
      userId: this.cls.get('user.id'),
      fields: fieldVos.map((field, i) => ({
        ...field,
        columnMeta: columnsMeta[i],
        references: fieldIds.concat(referenceMap[field.id]?.map((ref) => ref.toFieldId) || []),
      })),
      records,
    });

    return fields;
  }

  async deleteField(tableId: string, fieldId: string, windowId?: string) {
    await this.deleteFields(tableId, [fieldId], windowId);
  }

  private async updateUniqProperty(
    tableId: string,
    fieldId: string,
    key: 'name' | 'dbFieldName',
    value: string
  ) {
    const result = await this.prismaService.field
      .findFirstOrThrow({
        where: { id: fieldId, deletedTime: null },
        select: { [key]: true },
      })
      .catch(() => {
        throw new NotFoundException(`Field ${fieldId} not found`);
      });

    const hasDuplicated = await this.prismaService.field.findFirst({
      where: { tableId, [key]: value, deletedTime: null },
      select: { id: true },
    });

    if (hasDuplicated) {
      throw new BadRequestException(`Field ${key} ${value} already exists`);
    }

    return FieldOpBuilder.editor.setFieldProperty.build({
      key,
      oldValue: result[key],
      newValue: value,
    });
  }

  async updateField(tableId: string, fieldId: string, updateFieldRo: IUpdateFieldRo) {
    const ops: IOtOperation[] = [];
    if (updateFieldRo.name) {
      const op = await this.updateUniqProperty(tableId, fieldId, 'name', updateFieldRo.name);
      ops.push(op);
    }

    if (updateFieldRo.dbFieldName) {
      const op = await this.updateUniqProperty(
        tableId,
        fieldId,
        'dbFieldName',
        updateFieldRo.dbFieldName
      );
      const oldField = await this.prismaService.field.findFirstOrThrow({
        where: {
          id: fieldId,
          deletedTime: null,
        },
        select: {
          dbFieldName: true,
          id: true,
        },
      });
      // do not need in transaction, causing just index name
      await this.tableIndexService.updateSearchFieldIndexName(tableId, oldField, {
        id: oldField.id,
        dbFieldName: updateFieldRo?.dbFieldName ?? oldField.dbFieldName,
      });
      ops.push(op);
    }

    if (updateFieldRo.description !== undefined) {
      const { description } = await this.prismaService.field
        .findFirstOrThrow({
          where: { id: fieldId, deletedTime: null },
          select: { description: true },
        })
        .catch(() => {
          throw new NotFoundException(`Field ${fieldId} not found`);
        });

      ops.push(
        FieldOpBuilder.editor.setFieldProperty.build({
          key: 'description',
          oldValue: description,
          newValue: updateFieldRo.description,
        })
      );
    }

    await this.prismaService.$tx(async () => {
      await this.fieldService.batchUpdateFields(tableId, [{ fieldId, ops }]);
    });
  }

  async performConvertField({
    tableId,
    newField,
    oldField,
    modifiedOps,
    supplementChange,
  }: {
    tableId: string;
    newField: IFieldInstance;
    oldField: IFieldInstance;
    modifiedOps?: IOpsMap;
    supplementChange?: {
      tableId: string;
      newField: IFieldInstance;
      oldField: IFieldInstance;
    };
  }) {
    // 1. stage close constraint
    await this.fieldConvertingService.closeConstraint(tableId, newField, oldField);

    // 2. stage alter field
    await this.prismaService.$tx(async () => {
      await this.fieldViewSyncService.convertDependenciesByFieldIds(tableId, newField, oldField);
      await this.fieldConvertingService.stageAlter(tableId, newField, oldField);
      await this.fieldConvertingService.deleteOrCreateSupplementLink(tableId, newField, oldField);
      // for modify supplement link
      if (supplementChange) {
        const { tableId, newField, oldField } = supplementChange;
        await this.fieldConvertingService.stageAlter(tableId, newField, oldField);
      }
    });

    // 3. stage apply record changes and calculate field
    await this.prismaService.$tx(
      async () => {
        await this.fieldConvertingService.stageCalculate(tableId, newField, oldField, modifiedOps);

        if (supplementChange) {
          const { tableId, newField, oldField } = supplementChange;
          await this.fieldConvertingService.stageCalculate(tableId, newField, oldField);
        }
      },
      { timeout: this.thresholdConfig.bigTransactionTimeout }
    );

    // 4. stage supplement field constraint
    await this.prismaService.$tx(async () => {
      await this.fieldConvertingService.alterFieldConstraint(tableId, newField, oldField);
    });
  }

  async convertField(
    tableId: string,
    fieldId: string,
    updateFieldRo: IConvertFieldRo,
    windowId?: string
  ): Promise<IFieldVo> {
    // stage analysis and collect field changes
    const { newField, oldField, modifiedOps, supplementChange, references } =
      await this.fieldConvertingService.stageAnalysis(tableId, fieldId, updateFieldRo);

    await this.performConvertField({
      tableId,
      newField,
      oldField,
      modifiedOps,
      supplementChange,
    });

    const oldFieldVo = instanceToPlain(oldField, { excludePrefixes: ['_'] }) as IFieldVo;
    const newFieldVo = instanceToPlain(newField, { excludePrefixes: ['_'] }) as IFieldVo;

    this.cls.set('oldField', oldFieldVo);

    if (windowId) {
      this.eventEmitterService.emitAsync(Events.OPERATION_FIELD_CONVERT, {
        windowId,
        tableId,
        userId: this.cls.get('user.id'),
        oldField: oldFieldVo,
        newField: newFieldVo,
        modifiedOps,
        references,
        supplementChange,
      });
    }

    return newFieldVo;
  }

  async getFilterLinkRecords(tableId: string, fieldId: string) {
    const field = await this.fieldService.getField(tableId, fieldId);

    if (field.type !== FieldType.Link) return [];

    const { filter, foreignTableId } = field.options as ILinkFieldOptions;

    if (!foreignTableId || !filter) return [];

    return this.viewOpenApiService.getFilterLinkRecordsByTable(foreignTableId, filter);
  }

  async duplicateField(
    sourceTableId: string,
    fieldId: string,
    duplicateFieldRo: IDuplicateFieldRo,
    windowId?: string
  ) {
    const { name, viewId } = duplicateFieldRo;
    const prisma = this.prismaService.txClient();

    // throw error if field not found
    const fieldRaw = await prisma.field.findUniqueOrThrow({
      where: {
        id: fieldId,
        deletedTime: null,
      },
    });

    const fieldName = await this.fieldSupplementService.uniqFieldName(sourceTableId, name);

    const dbFieldName = await this.fieldService.generateDbFieldName(sourceTableId, fieldName);

    const fieldInstance = createFieldInstanceByRaw(fieldRaw);

    const newFieldInstance = {
      ...fieldInstance,
      name: fieldName,
      dbFieldName,
      id: generateFieldId(),
    } as IFieldInstance;

    delete newFieldInstance.isPrimary;

    if (viewId) {
      const view = await prisma.view.findUniqueOrThrow({
        where: { id: viewId, deletedTime: null },
        select: {
          id: true,
          columnMeta: true,
        },
      });
      const columnMeta = (view.columnMeta ? JSON.parse(view.columnMeta) : {}) as IColumnMeta;
      const fieldViewOrder = columnMeta[fieldId]?.order;

      const getterFieldViewOrders = Object.values(columnMeta)
        .filter(({ order }) => order > fieldViewOrder)
        .map(({ order }) => order)
        .sort();

      const targetFieldViewOrder = getterFieldViewOrders?.length
        ? (getterFieldViewOrders[0] + fieldViewOrder) / 2
        : fieldViewOrder + 1;

      (newFieldInstance as IFieldRo).order = {
        viewId,
        orderIndex: targetFieldViewOrder,
      };
    }

    // create field may not support notNull and unique validate
    delete newFieldInstance.notNull;
    delete newFieldInstance.unique;

    if (FieldType.Link === fieldInstance.type && !fieldInstance.isLookup) {
      newFieldInstance.options = {
        ...pick(fieldInstance.options, [
          'filter',
          'filterByViewId',
          'foreignTableId',
          'relationship',
          'visibleFieldIds',
        ]),
        // all link field should be one way link
        isOneWay: true,
      };
    }

    if (fieldInstance.isLookup || fieldInstance.type === FieldType.Rollup) {
      newFieldInstance.lookupOptions = {
        ...pick(fieldInstance.lookupOptions, [
          'foreignTableId',
          'lookupFieldId',
          'linkFieldId',
          'filter',
        ]),
      } as IFieldInstance['lookupOptions'];
    }

    // after create field, and add constraint relative
    const newField = await this.createField(sourceTableId, {
      ...omit(newFieldInstance, ['notNull', 'unique']),
    });

    if (!fieldInstance.isComputed) {
      // do not async duplicate records
      this.duplicateFieldData(
        sourceTableId,
        newField.id,
        fieldRaw.dbFieldName,
        omit(newFieldInstance, 'order') as IFieldInstance
      );
    }

    this.eventEmitterService.emitAsync(Events.OPERATION_FIELDS_CREATE, {
      operationId: generateOperationId(),
      windowId,
      tableId: sourceTableId,
      userId: this.cls.get('user.id'),
      fields: [newField],
    });

    return newField;
  }

  async duplicateFieldData(
    sourceTableId: string,
    targetFieldId: string,
    sourceDbFieldName: string,
    fieldInstance: IFieldInstance
  ) {
    const chunkSize = 1000;

    const dbTableName = await this.fieldService.getDbTableName(sourceTableId);

    const count = await this.getFieldRecordsCount(dbTableName, sourceDbFieldName);

    if (!count) {
      if (fieldInstance.notNull || fieldInstance.unique) {
        await this.convertField(sourceTableId, targetFieldId, {
          ...fieldInstance,
          notNull: fieldInstance.notNull,
          unique: fieldInstance.unique,
        });
      }
      return;
    }

    const page = Math.ceil(count / chunkSize);

    for (let i = 0; i < page; i++) {
      const sourceRecords = await this.getFieldRecords(
        dbTableName,
        sourceDbFieldName,
        i,
        chunkSize
      );

      await this.prismaService.$tx(async () => {
        await this.recordOpenApiService.simpleUpdateRecords(sourceTableId, {
          fieldKeyType: FieldKeyType.Id,
          typecast: true,
          records: sourceRecords.map((record) => ({
            id: record.id,
            fields: {
              [targetFieldId]: record.value,
            },
          })),
        });
      });
    }

    if (fieldInstance.notNull || fieldInstance.unique) {
      await this.convertField(sourceTableId, targetFieldId, {
        ...fieldInstance,
        notNull: fieldInstance.notNull,
        unique: fieldInstance.unique,
      });
    }
  }

  private async getFieldRecordsCount(dbTableName: string, dbFieldName: string) {
    const query = this.knex(dbTableName).count('*').whereNotNull(dbFieldName).toQuery();
    const result = await this.prismaService.$queryRawUnsafe<{ count: number }[]>(query);
    return Number(result[0].count);
  }

  private async getFieldRecords(
    dbTableName: string,
    dbFieldName: string,
    page: number,
    chunkSize: number
  ) {
    const query = this.knex(dbTableName)
      .select({ id: '__id', value: dbFieldName })
      .whereNotNull(dbFieldName)
      .orderBy('__auto_number')
      .limit(chunkSize)
      .offset(page * chunkSize)
      .toQuery();
    const result = await this.prismaService.$queryRawUnsafe<{ id: string; value: string }[]>(query);
    return result.map((item) => item);
  }

  getFieldUniqueKeyName(dbTableName: string, dbFieldName: string, fieldId: string) {
    return this.fieldService.getFieldUniqueKeyName(dbTableName, dbFieldName, fieldId);
  }
}
