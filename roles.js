import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { z } from 'zod';

export const emailField = z.string().trim().toLowerCase().pipe(z.email().max(254));
export async function provision(tx, role, address, actor = null) {
  const email = emailField.parse(address);
  const id = randomUUID();
  const password = randomBytes(18).toString('base64url');
  const password_hash = await hash(password,{memoryCost:19456,timeCost:2,parallelism:1});
  const rows = await tx.users.createManyAndReturn({data:[{id,email,password_hash,account_role:z.enum(['patient','family','specialist','admin']).parse(role)}],skipDuplicates:true,select:{id:true}});
  if (!rows.length) throw Object.assign(new Error('Этот email уже зарегистрирован'),{statusCode:409});
  await tx.audit_events.createMany({data:[{actor_id:actor,action:'create_'+role,resource_type:'user',resource_id:id,outcome:'success'}]});
  return {id,email,password,role};
}
