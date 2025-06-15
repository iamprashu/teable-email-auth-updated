// Replace the entire content of your file with this:
import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { axios } from '../axios'; // Assuming this path is correct
import { registerRoute } from '../utils'; // Assuming this path is correct
import { z } from '../zod'; // Assuming this path is correct

export const CHANGE_EMAIL = '/auth/change-email';

// --- START MODIFIED CODE ---

// Updated schema for changing email
// It now expects 'newEmail' and 'password' directly, bypassing 'token' and 'code'.
export const changeEmailRoSchema = z.object({
  newEmail: z.string().email('Invalid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters long.'), // Adjust min length as per your password policy
});

// The interface will automatically infer from the updated schema.
export type IChangeEmailRo = z.infer<typeof changeEmailRoSchema>;

// The OpenAPI route configuration will also automatically update based on the new schema.
export const changeEmailRoute: RouteConfig = registerRoute({
  method: 'patch',
  path: CHANGE_EMAIL,
  description: 'Change email',
  request: {
    body: {
      content: {
        'application/json': {
          schema: changeEmailRoSchema, // This now references the new schema
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Change email successfully',
    },
    // You might want to add 400 (Bad Request), 401 (Unauthorized), 409 (Conflict) responses here
    // based on the new backend validation logic.
  },
  tags: ['auth'],
});

// The client-side function that makes the API call.
// Its 'ro' parameter (type IChangeEmailRo) will now correctly expect newEmail and password.
// The actual axios call logic remains the same: it sends the 'ro' object.
export const changeEmail = async (ro: IChangeEmailRo) => {
  return axios.patch<void>(CHANGE_EMAIL, ro);
};

// --- END MODIFIED CODE ---