// app/components/source-fields.tsx —— 数据源连接参数的表单字段（登记与修改共用），按类型显示对应字段。
// 凭据字段（密码、Access Key、Secret Key）永远是空的：修改时留空表示沿用已保存的凭据
import type { SourceKind } from '~/lib/sources';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';

type Values = Record<string, string | undefined>;

function TextField({ name, label, values, placeholder, type = 'text', required, hint }: {
  name: string;
  label: string;
  values: Values;
  placeholder?: string;
  type?: string;
  required?: boolean;
  hint?: string;
}) {
  const id = `source-${name}`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} name={name} type={type} required={required} placeholder={placeholder} defaultValue={values[name] ?? ''}
        autoComplete={type === 'password' ? 'new-password' : 'off'} />
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </Field>
  );
}

function SecretField({ name, label, editing }: { name: string; label: string; editing: boolean }) {
  const id = `source-${name}`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} name={name} type="password" autoComplete="new-password" required={!editing}
        placeholder={editing ? '已加密保存，留空表示不变' : undefined} />
    </Field>
  );
}

function S3Fields({ values, editing, optional }: { values: Values; editing: boolean; optional?: boolean }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <TextField name="endpoint" label="对象存储地址" values={values} placeholder="s3.amazonaws.com 或 localhost:8333" />
        <TextField name="region" label="区域" values={values} placeholder="us-east-1" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field>
          <FieldLabel htmlFor="source-urlStyle">寻址方式</FieldLabel>
          <NativeSelect id="source-urlStyle" name="urlStyle" defaultValue={values.urlStyle ?? 'path'}>
            <NativeSelectOption value="path">path（/bucket/key）</NativeSelectOption>
            <NativeSelectOption value="vhost">vhost（bucket.host/key）</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="source-useSsl">HTTPS</FieldLabel>
          <NativeSelect id="source-useSsl" name="useSsl" defaultValue={values.useSsl ?? 'true'}>
            <NativeSelectOption value="true">使用</NativeSelectOption>
            <NativeSelectOption value="false">不使用</NativeSelectOption>
          </NativeSelect>
        </Field>
      </div>
      {optional
        ? <FieldDescription>以上与下面的密钥只对对象存储上的文件（s3://…）需要。</FieldDescription>
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
  return (
    <FieldGroup>
      {(kind === 'postgres' || kind === 'mysql') && (
        <>
          <div className="grid grid-cols-[1fr_8rem] gap-4">
            <TextField name="host" label="主机" values={values} required />
            <TextField name="port" label="端口" values={values} placeholder={kind === 'postgres' ? '5432' : '3306'} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <TextField name="database" label="数据库名" values={values} required />
            {kind === 'postgres' && <TextField name="schema" label="schema" values={values} placeholder="public" />}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <TextField name="user" label="用户名" values={values} required hint="必须是只读账号：可写的账号会被拒绝" />
            <SecretField name="password" label="密码" editing={editing} />
          </div>
        </>
      )}
      {kind === 's3' && (
        <>
          <div className="grid grid-cols-[1fr_10rem] gap-4">
            <TextField name="path" label="文件前缀" values={values} required placeholder="s3://bucket/crm/"
              hint="前缀下的每个子目录（或顶层的每个文件）是一张表" />
            <Field>
              <FieldLabel htmlFor="source-format">文件格式</FieldLabel>
              <NativeSelect id="source-format" name="format" defaultValue={values.format ?? 'parquet'}>
                <NativeSelectOption value="parquet">Parquet</NativeSelectOption>
                <NativeSelectOption value="csv">CSV</NativeSelectOption>
                <NativeSelectOption value="json">JSON</NativeSelectOption>
              </NativeSelect>
            </Field>
          </div>
          <S3Fields values={values} editing={editing} />
          <FieldDescription>账号必须只读：能写入该前缀的账号会被拒绝。</FieldDescription>
        </>
      )}
      {kind === 'duckdb' && (
        <>
          <TextField name="path" label="DuckDB 文件" values={values} required placeholder="shop.duckdb 或 s3://bucket/path/shop.duckdb"
            hint="本机文件须放在本租户的源文件目录中，填相对路径；以只读方式挂载" />
          <S3Fields values={values} editing={editing} optional />
        </>
      )}
    </FieldGroup>
  );
}
