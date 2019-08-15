import * as R from 'ramda';
import { logger } from '@lagoon/commons/src/local-logging';
import { keycloakAdminClient } from '../../clients/keycloakClient';
import { getSqlClient } from '../../clients/sqlClient';
import { query, prepare } from '../../util/db';
import { Group, GroupNotFoundError } from '../../models/group';
import { User } from '../../models/user';

const keycloakAuth = {
  username: 'admin',
  password: R.pathOr(
    '<password not set>',
    ['env', 'KEYCLOAK_ADMIN_PASSWORD'],
    process,
  ) as string,
  grantType: 'password',
  clientId: 'admin-cli',
};

const refreshToken = async keycloakAdminClient => {
  const tokenRaw = new Buffer(keycloakAdminClient.accessToken.split('.')[1], 'base64');
  const token = JSON.parse(tokenRaw.toString());
  const date = new Date();
  const now = Math.floor(date.getTime() / 1000);

  if (token.exp <= now) {
    logger.debug('Refreshing keycloak token');
    keycloakAdminClient.setConfig({ realmName: 'master' });
    await keycloakAdminClient.auth(keycloakAuth);
    keycloakAdminClient.setConfig({ realmName: 'lagoon' });
  }
}

(async () => {
  keycloakAdminClient.setConfig({ realmName: 'master' });
  await keycloakAdminClient.auth(keycloakAuth);
  keycloakAdminClient.setConfig({ realmName: 'lagoon' });

  const sqlClient = getSqlClient();
  const GroupModel = Group();
  const UserModel = User();

  const customerRecords = await query(sqlClient, 'SELECT * FROM `customer`');

  for (const customer of customerRecords) {
    await refreshToken(keycloakAdminClient);
    logger.debug(`Processing ${customer.name}`);

    // Add or update group
    let keycloakGroup;
    try {
      const existingGroup = await GroupModel.loadGroupByName(customer.name);
      keycloakGroup = await GroupModel.updateGroup({
        id: existingGroup.id,
        name: existingGroup.name,
        attributes: {
          ...existingGroup.attributes,
          comment: [
            R.propOr(
              R.path(['attributes', 'comment', 0], existingGroup),
              'comment',
              customer,
            ),
          ],
        },
      });
    } catch (err) {
      if (err instanceof GroupNotFoundError) {
        try {
          keycloakGroup = await GroupModel.addGroup({
            name: R.prop('name', customer),
            attributes: {
              comment: [R.prop('comment', customer)],
            },
          });
        } catch (err) {
          logger.error(`Could not add group ${customer.name}: ${err.message}`);
          continue;
        }
      } else {
        logger.error(`Could not update group ${customer.name}: ${err.message}`);
      }
    }

    // Add customer users to group
    const customerUserQuery = prepare(
      sqlClient,
      'SELECT u.email FROM customer_user cu LEFT JOIN user u on cu.usid = u.id WHERE cu.cid = :cid',
    );
    const customerUserRecords = await query(
      sqlClient,
      customerUserQuery({
        cid: customer.id,
      }),
    );

    for (const customerUser of customerUserRecords) {
      await refreshToken(keycloakAdminClient);

      try {
        const user = await UserModel.loadUserByUsername(customerUser.email);
        await GroupModel.addUserToGroup(user, keycloakGroup, 'owner');
      } catch (err) {
        logger.error(
          `Could not add user (${customerUser.email}) to group (${
            keycloakGroup.name
          }): ${err.message}`,
        );
      }
    }

    // Add customer projects to group
    const customerProjectQuery = prepare(
      sqlClient,
      'SELECT id, name FROM project WHERE customer = :cid',
    );
    const customerProjectRecords = await query(
      sqlClient,
      customerProjectQuery({
        cid: customer.id,
      }),
    );

    for (const customerProject of customerProjectRecords) {
      await refreshToken(keycloakAdminClient);

      try {
        await GroupModel.addProjectToGroup(customerProject.id, keycloakGroup);
      } catch (err) {
        logger.error(
          `Could not add project (${customerProject.name}) to group (${
            keycloakGroup.name
          }): ${err.message}`,
        );
      }
    }
  }

  logger.info('Migration completed');

  sqlClient.destroy();
})();
