// app/components/source-fields.tsx —— 数据源连接参数的表单字段（登记与修改共用），按类型显示对应字段。
// 凭据字段（密码、Access Key、Secret Key）永远是空的：修改时留空表示沿用已保存的凭据
import type { SourceKind } from '~/lib/sources';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { useT } from '~/lib/i18n';

type Values = Record<string, string | undefined>;

function TextField({ name, label, values, placeholder, type = 'text', required, readOnly, hint }: {
  name: string;
  label: string;
  values: Values;
  placeholder?: string;
  type?: string;
  required?: boolean;
  readOnly?: boolean;
  hint?: string;
}) {
  const id = `source-${name}`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} name={name} type={type} required={required} readOnly={readOnly} placeholder={placeholder} defaultValue={values[name] ?? ''}
        autoComplete={type === 'password' ? 'new-password' : 'off'} />
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </Field>
  );
}

function SecretField({ name, label, editing }: { name: string; label: string; editing: boolean }) {
  const t = useT();
  const id = `source-${name}`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} name={name} type="password" autoComplete="new-password" required={!editing}
        placeholder={editing ? t('已加密保存，留空表示不变') : undefined} />
    </Field>
  );
}

function S3Fields({ values, editing, optional }: { values: Values; editing: boolean; optional?: boolean }) {
  const t = useT();
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <TextField name="endpoint" label={t('对象存储地址')} values={values} placeholder={t('s3.amazonaws.com 或 localhost:8333')} />
        <TextField name="region" label={t('区域')} values={values} placeholder="us-east-1" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field>
          <FieldLabel htmlFor="source-urlStyle">{t('寻址方式')}</FieldLabel>
          <NativeSelect id="source-urlStyle" name="urlStyle" defaultValue={values.urlStyle ?? 'path'}>
            <NativeSelectOption value="path">{t('path（/bucket/key）')}</NativeSelectOption>
            <NativeSelectOption value="vhost">{t('vhost（bucket.host/key）')}</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="source-useSsl">HTTPS</FieldLabel>
          <NativeSelect id="source-useSsl" name="useSsl" defaultValue={values.useSsl ?? 'true'}>
            <NativeSelectOption value="true">{t('使用')}</NativeSelectOption>
            <NativeSelectOption value="false">{t('不使用')}</NativeSelectOption>
          </NativeSelect>
        </Field>
      </div>
      {optional
        ? <FieldDescription>{t('以上与下面的密钥只对对象存储上的文件（s3://…）需要。')}</FieldDescription>
        : null}
      <div className="grid grid-cols-2 gap-4">
        <SecretField name="keyId" label="Access Key" editing={editing || !!optional} />
        <SecretField name="secret" label="Secret Key" editing={editing || !!optional} />
      </div>
    </>
  );
}

/** kind 决定显示哪些字段；editing 为 true 时凭据字段可以留空 */
export function SourceFields({ kind, values, editing = false }: { kind: SourceKind; values: Values; editing?: boolean }) {
  const t = useT();
  return (
    <FieldGroup>
      {(kind === 'postgres' || kind === 'mysql') && (
        <>
          <div className="grid grid-cols-[1fr_8rem] gap-4">
            <TextField name="host" label={t('主机')} values={values} required />
            <TextField name="port" label={t('端口')} values={values} placeholder={kind === 'postgres' ? '5432' : '3306'} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <TextField name="database" label={t('数据库名')} values={values} required />
            {kind === 'postgres' && <TextField name="schema" label="schema" values={values} placeholder="public" />}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <TextField name="user" label={t('用户名')} values={values} required hint={t('必须是只读账号：可写的账号会被拒绝')} />
            <SecretField name="password" label={t('密码')} editing={editing} />
          </div>
        </>
      )}
      {kind === 'mongodb' && (
        <>
          <div className="grid grid-cols-[1fr_8rem] gap-4">
            <TextField name="host" label={t('主机')} values={values} required placeholder={t('localhost 或 cluster0.xxxxx.mongodb.net')} />
            <TextField name="port" label={t('端口')} values={values} placeholder="27017" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="source-srv">{t('连接方式')}</FieldLabel>
              <NativeSelect id="source-srv" name="srv" defaultValue={values.srv ?? 'false'}>
                <NativeSelectOption value="false">{t('主机与端口')}</NativeSelectOption>
                <NativeSelectOption value="true">{t('SRV 记录（MongoDB Atlas，自动使用 TLS）')}</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="source-tls">TLS</FieldLabel>
              <NativeSelect id="source-tls" name="tls" defaultValue={values.tls ?? 'false'}>
                <NativeSelectOption value="false">{t('不使用')}</NativeSelectOption>
                <NativeSelectOption value="true">{t('使用')}</NativeSelectOption>
              </NativeSelect>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <TextField name="database" label={t('数据库名')} values={values} required hint={t('库里的每个集合是一张表')} />
            <TextField name="authSource" label={t('认证库')} values={values} placeholder="admin" hint={t('账号创建在哪个库里，默认 admin')} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <TextField name="user" label={t('用户名')} values={values} required hint={t('必须是只读账号（如 read 角色）：可写的账号会被拒绝')} />
            <SecretField name="password" label={t('密码')} editing={editing} />
          </div>
        </>
      )}
      {kind === 's3' && (
        <>
          <div className="grid grid-cols-[1fr_10rem] gap-4">
            <TextField name="path" label={t('文件前缀')} values={values} required placeholder="s3://bucket/crm/"
              hint={t('前缀下的每个子目录（或顶层的每个文件）是一张表')} />
            <Field>
              <FieldLabel htmlFor="source-format">{t('文件格式')}</FieldLabel>
              <NativeSelect id="source-format" name="format" defaultValue={values.format ?? 'parquet'}>
                <NativeSelectOption value="parquet">Parquet</NativeSelectOption>
                <NativeSelectOption value="csv">CSV</NativeSelectOption>
                <NativeSelectOption value="json">JSON</NativeSelectOption>
              </NativeSelect>
            </Field>
          </div>
          <S3Fields values={values} editing={editing} />
          <FieldDescription>{t('账号必须只读：能写入该前缀的账号会被拒绝。')}</FieldDescription>
        </>
      )}
      {kind === 'duckdb' && (
        <>
          <TextField name="path" label={t('DuckDB 文件')} values={values} required placeholder={t('shop.duckdb 或 s3://bucket/path/shop.duckdb')}
            hint={t('本机文件须放在本租户的源文件目录中，填相对路径；以只读方式挂载')} />
          <S3Fields values={values} editing={editing} optional />
        </>
      )}
      {kind === 'upload' && (
        <div className="grid grid-cols-2 gap-4">
          <TextField name="table" label={t('表名')} values={values} required readOnly={editing}
            hint={editing ? t('上传后不能修改') : t('小写字母、数字与下划线，以字母开头')} placeholder={t('如：signups')} />
          {!editing && (
            <Field>
              <FieldLabel htmlFor="source-file">{t('CSV 文件')}</FieldLabel>
              <Input id="source-file" name="file" type="file" accept=".csv" required />
              <FieldDescription>{t('UTF-8 或 GBK 编码；点「预览」可以确认或修改分隔符、表头与列类型')}</FieldDescription>
            </Field>
          )}
        </div>
      )}
    </FieldGroup>
  );
}
